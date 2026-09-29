// SMTP 客户端：基于 Cloudflare Workers 的 TCP socket API（cloudflare:sockets）
// - 465 端口：隐式 TLS（implicit TLS），建连即加密
// - 587 等端口：显式 TLS（STARTTLS），必须在发 AUTH 之前完成升级
//
// 安全基线（P0-1）：Cloudflare 的 secureTransport:'starttls' 语义是「先建明文连接，
// 调用 socket.startTls() 之后才加密」，它**不会自动升级**。历史上此处只设了 'starttls'
// 却从未调用 startTls()，导致 587 端口下 EHLO 与 AUTH LOGIN 全程跑在明文 TCP 上，
// base64 的授权码可被链路中间人直接还原。现在：非 465 端口强制走 STARTTLS 升级，
// 且升级前先校验服务器声明支持 STARTTLS，未声明则直接拒绝连接——宁可发不出邮件，
// 也不明文发送凭据。
// 支持 AUTH LOGIN，收件人单个（本系统告警场景足够）

import { connect } from 'cloudflare:sockets';

// cloudflare:sockets 的 Socket 与全局 Socket（@cloudflare/workers-types）是两套类型：
// 前者才带 startTls()。这里用 connect 的返回类型，避免两处类型断言漂移。
type CfSocket = ReturnType<typeof connect>;

export interface SmtpConfig {
  host: string;
  port: number; // 建议 465；587 会走 STARTTLS 升级
  username: string; // 登录用户（通常即发件邮箱）
  password: string; // 授权码（非登录密码）
  from: string; // 发件人邮箱
  to: string; // 收件人邮箱
}

function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

/**
 * P1-4：单步读写超时。SMTP 走的是裸 TCP，服务端「连得上但不回包」时会永久挂起，
 * 把整个通知流程（乃至监控周期）拖住。这里给每次读取设上限，超时即抛错。
 */
const SMTP_STEP_TIMEOUT_MS = 10_000;

// 读取一条 SMTP 回复：多行回复形如 "250-ONE\r\n250 TWO\r\n"，以第 4 字符为空格的行结束
class SmtpConn {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buf = new Uint8Array(0);
  private dec = new TextDecoder();

  constructor(socket: Socket) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  private async readMore(): Promise<boolean> {
    // P1-4：给读取加超时，避免服务端不回包时无限挂起
    const timeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), SMTP_STEP_TIMEOUT_MS);
    });
    const res = await Promise.race([this.reader.read(), timeout]);
    if (res === 'timeout') throw new Error(`SMTP 读取超时（${SMTP_STEP_TIMEOUT_MS}ms）`);
    const { done, value } = res;
    if (done) return false;
    const merged = new Uint8Array(this.buf.length + value.length);
    merged.set(this.buf);
    merged.set(value, this.buf.length);
    this.buf = merged;
    return true;
  }

  // 返回完成行之前的全部回复文本
  async reply(): Promise<string> {
    const start = this.dec.decode(this.buf).length;
    for (;;) {
      const text = this.dec.decode(this.buf).slice(start);
      const lines = text.split('\r\n');
      // 最后一段可能是未完整的行
      if (lines.length >= 2) {
        const complete = lines.slice(0, -1);
        const last = complete[complete.length - 1];
        if (last.length >= 4 && last[3] === ' ') {
          return complete.join('\n');
        }
      }
      if (!(await this.readMore())) throw new Error('SMTP 连接中断：' + text);
    }
  }

  /** 只写不读，用于 STARTTLS 这类「响应码不是 2xx/4xx 模式」的命令 */
  async sendLine(line: string): Promise<void> {
    await this.writer.write(new TextEncoder().encode(line + '\r\n'));
  }

  async cmd(line: string): Promise<string> {
    await this.sendLine(line);
    const r = await this.reply();
    const code = parseInt(r.slice(0, 3), 10);
    // 4xx/5xx 视为失败
    if (code >= 400) throw new Error(`SMTP ${code}: ${r}`);
    return r;
  }

  /**
   * 释放流锁（不关闭底层 socket）。STARTTLS 升级前必须调用：startTls() 会接管连接，
   * 若明文流的 reader/writer 仍持锁，升级后无法在新 socket 上重新取流。
   */
  async release(): Promise<void> {
    try { this.writer.releaseLock(); } catch { /* ignore */ }
    try { this.reader.releaseLock(); } catch { /* ignore */ }
  }

  async close(): Promise<void> {
    try { await this.writer.close(); } catch { /* ignore */ }
    try { this.reader.releaseLock(); } catch { /* ignore */ }
  }
}

// 校验回复以指定前缀码开头（用于 greeting/DATA 等不经过 cmd() 的场景）
function assertCode(reply: string, expect: number, what: string): void {
  const code = parseInt(reply.slice(0, 3), 10);
  if (code !== expect) throw new Error(`SMTP ${what} 失败 ${code}: ${reply}`);
}

/**
 * 建立连接并完成必要的 TLS 升级。
 * 返回升级后的 socket 与会话对象：465 直接是 TLS，其余端口走 STARTTLS。
 */
async function openSecureSession(
  cfg: SmtpConfig,
): Promise<{ socket: CfSocket; conn: SmtpConn }> {
  const port = cfg.port || 465;
  const implicit = port === 465;
  let socket: CfSocket = connect(
    { hostname: cfg.host, port },
    { secureTransport: implicit ? 'on' : 'starttls', allowHalfOpen: false },
  );
  let conn = new SmtpConn(socket as unknown as Socket);

  const greet = await conn.reply();
  assertCode(greet, 220, 'greeting');
  const ehlo = await conn.cmd('EHLO cdt-monitor');

  if (implicit) return { socket, conn };

  // —— 显式 TLS：必须先升级，才能发送任何凭据 ——
  // 服务器必须在 EHLO 响应里声明 STARTTLS，否则拒绝继续：
  // 明文发送 AUTH LOGIN 等同于把授权码交给链路中间人（授权码 = 邮箱完整发信权限）。
  if (!/\bSTARTTLS\b/i.test(ehlo)) {
    throw new Error(
      `SMTP 服务器未声明支持 STARTTLS，已拒绝连接以免明文发送凭据（${cfg.host}:${port}）。` +
      `请改用 465 端口（隐式 TLS），或确认服务器已开启 STARTTLS。`,
    );
  }
  await conn.sendLine('STARTTLS');
  const ready = await conn.reply();
  assertCode(ready, 220, 'STARTTLS');

  await conn.release();
  // startTls() 返回一个新的 Socket，原 socket 的流此后失效
  const upgraded = (socket as unknown as { startTls(): CfSocket }).startTls();
  socket = upgraded;
  conn = new SmtpConn(upgraded as unknown as Socket);

  // 升级后必须重新 EHLO：能力列表在 TLS 层内可能不同
  await conn.cmd('EHLO cdt-monitor');
  return { socket, conn };
}

// 拒绝含控制字符（CR/LF 及其他 < 0x20）的发件人/收件人，防 SMTP 命令（CRLF）注入
function assertSafeSmtpAddress(field: string, value: string): void {
  if (/[\x00-\x1f]/.test(value)) {
    throw new Error(`SMTP ${field} 含非法控制字符（可能的命令注入），已拒绝发送`);
  }
}

// 发送 HTML 邮件（UTF-8，base64 传输编码）
export async function sendSmtpMail(
  cfg: SmtpConfig,
  subject: string,
  html: string,
): Promise<void> {
  const { socket, conn } = await openSecureSession(cfg);
  // P1-4：无论成功失败都必须回收 socket —— Free 计划同时打开的连接数上限 6，
  // 泄漏的 socket 会持续占额并可能挤掉并发的阿里云 fetch。
  try {
    // 此刻连接已是 TLS，发送凭据是安全的
    const authPrompt = await conn.cmd('AUTH LOGIN');
    if (!authPrompt.startsWith('334')) throw new Error(`SMTP AUTH 无法开始: ${authPrompt}`);
    const userPrompt = await conn.cmd(b64(cfg.username));
    if (!userPrompt.startsWith('334')) throw new Error(`SMTP 用户名被拒: ${userPrompt}`);
    const authed = await conn.cmd(b64(cfg.password));
    if (!authed.startsWith('235')) throw new Error(`SMTP 认证失败: ${authed}`);

    // P-smtp-1：MAIL FROM / RCPT TO 直接把管理员配置拼进 SMTP 命令，
    // 若含 CR/LF 等控制字符可被注入额外命令（SMTP CRLF 注入），发送前清洗。
    assertSafeSmtpAddress('from', cfg.from);
    assertSafeSmtpAddress('to', cfg.to);
    await conn.cmd(`MAIL FROM:<${cfg.from}>`);
    await conn.cmd(`RCPT TO:<${cfg.to}>`);
    const dataResp = await conn.cmd('DATA');
    if (!dataResp.startsWith('354')) throw new Error(`SMTP DATA 失败: ${dataResp}`);

    // 主题按 RFC 2047 base64 编码，正文 base64 分行
    const headers =
      `From: "CDT Monitor" <${cfg.from}>\r\n` +
      `To: <${cfg.to}>\r\n` +
      `Subject: =?UTF-8?B?${b64(subject)}?=\r\n` +
      `Date: ${new Date().toUTCString()}\r\n` +
      `MIME-Version: 1.0\r\n` +
      `Content-Type: text/html; charset=UTF-8\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n`;
    const bodyB64 = b64(html).replace(/(.{76})/g, '$1\r\n');
    await conn.cmd(headers + bodyB64 + '\r\n.');
    try { await conn.cmd('QUIT'); } catch { /* 对方可能直接关闭 */ }
  } finally {
    try { await conn.close(); } catch { /* ignore */ }
    try { await socket.close(); } catch { /* ignore */ }
  }
}
