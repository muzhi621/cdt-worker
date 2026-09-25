// SMTP 客户端：基于 Cloudflare Workers 的 TCP socket API（cloudflare:sockets）
// 走 465 端口 implicit TLS（25 端口被 Workers 封锁，587 starttls 亦可但 465 更稳）
// 支持 AUTH LOGIN，收件人单个（本系统告警场景足够）

import { connect } from 'cloudflare:sockets';

export interface SmtpConfig {
  host: string;
  port: number; // 建议 465
  username: string; // 登录用户（通常即发件邮箱）
  password: string; // 授权码（非登录密码）
  from: string; // 发件人邮箱
  to: string; // 收件人邮箱
}

function b64(s: string): string {
  return btoa(unescape(encodeURIComponent(s)));
}

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
    const { done, value } = await this.reader.read();
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

  async cmd(line: string): Promise<string> {
    await this.writer.write(new TextEncoder().encode(line + '\r\n'));
    const r = await this.reply();
    const code = parseInt(r.slice(0, 3), 10);
    // 4xx/5xx 视为失败
    if (code >= 400) throw new Error(`SMTP ${code}: ${r}`);
    return r;
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

// 发送 HTML 邮件（UTF-8，base64 传输编码）
export async function sendSmtpMail(
  cfg: SmtpConfig,
  subject: string,
  html: string,
): Promise<void> {
  const port = cfg.port || 465;
  const socket = connect(
    { hostname: cfg.host, port },
    { secureTransport: port === 465 ? 'on' : 'starttls', allowHalfOpen: false },
  );
  const conn = new SmtpConn(socket as unknown as Socket);

  const greet = await conn.reply();
  assertCode(greet, 220, 'greeting');
  await conn.cmd('EHLO cdt-monitor');
  const authPrompt = await conn.cmd('AUTH LOGIN');
  if (!authPrompt.startsWith('334')) throw new Error(`SMTP AUTH 无法开始: ${authPrompt}`);
  const userPrompt = await conn.cmd(b64(cfg.username));
  if (!userPrompt.startsWith('334')) throw new Error(`SMTP 用户名被拒: ${userPrompt}`);
  const authed = await conn.cmd(b64(cfg.password));
  if (!authed.startsWith('235')) throw new Error(`SMTP 认证失败: ${authed}`);

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
  await conn.close();
}
