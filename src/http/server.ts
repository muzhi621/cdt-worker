// HTTP 层：路由 + 鉴权 + API
// 对应原 Go 项目 internal/httpapi/server.go
// 使用原生 fetch handler（Worker 环境），不引入第三方框架

import * as store from '../store/store';
import * as engine from '../engine/engine';
import { masked } from '../engine/engine';
import { hashPassword, verifyPassword, constantTimeEqual, envPassword, newToken, tokenHash, type Env } from '../security/security';
import { deliverEvent } from '../notify/service';
import { driverScript, installScript, uninstallScript } from '../engine/selfhost';
import {
  isSourceStale, normalizeSource, TRIGGER_GAP_THRESHOLD_SEC, TRIGGER_LABELS, TRIGGER_SOURCES,
  type TriggerSource,
} from '../engine/triggers';
import { formatWallClock } from '../engine/time';
import { runDdnsSync, previewGroups } from '../ddns/sync';
import * as ddnsStore from '../ddns/store';
import { listProviders } from '../ddns/providers';
import type { Account } from '../provider/aliyun';
import indexHtml from '../web/index.html';

type Context = { env: Env; request: Request; params: Record<string, string> };

// 幂等方法不做 CSRF 校验（无副作用）
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// API Key 最近一次「已刷新 last_used_at」的时间戳（isolate 内有效，用于写库节流）
const apiKeyUseCache = new Map<string, number>();

// index.html 的 ETag（每个 isolate 只算一次，之后复用）
let cachedETag = '';
async function htmlETag(): Promise<string> {
  if (cachedETag) return cachedETag;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(indexHtml));
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  cachedETag = `"${hex.slice(0, 32)}"`;
  return cachedETag;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function error(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

function clientIP(request: Request): string {
  // 优先用 Cloudflare 注入的 CF-Connecting-IP（不可伪造），X-Forwarded-For 仅作本地 dev 兜底。
  // 此前优先 XFF 可被客户端伪造，影响登录限流 key 与审计日志里的 IP。
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

// 简单内存限流（单 Isolate 内有效）
const rateMap = new Map<string, { start: number; count: number }>();
function allowRate(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  // 定期清理过期条目，防止 key 随 IP 数量无限增长（内存泄漏），
  // 同时避免 isolate 长活时旧 key 复用带来的计数残留
  if (rateMap.size > 500) {
    for (const [k, v] of rateMap) {
      if (now - v.start >= windowMs) rateMap.delete(k);
    }
  }
  const entry = rateMap.get(key);
  if (!entry || now - entry.start >= windowMs) {
    rateMap.set(key, { start: now, count: 1 });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count++;
  return true;
}

// 鉴权：API Key 或管理员 Session
interface Principal { admin: boolean; scopes: Set<string> }

async function authenticate(env: Env, request: Request): Promise<Principal | null> {
  const auth = request.headers.get('Authorization');
  let token = '';
  if (auth && auth.toLowerCase().startsWith('bearer ')) token = auth.slice(7).trim();
  else token = (request.headers.get('X-API-Key') || '').trim();

  if (token) {
    const hash = await tokenHash(token);
    const row = await env.DB.prepare(
      'SELECT scopes, expires_at FROM api_keys WHERE token_hash = ?',
    ).bind(hash).first();
    if (!row) return null;
    const r = row as Record<string, unknown>;
    if (r.expires_at && new Date(String(r.expires_at)).getTime() < Date.now()) return null;
    let scopes: string[] = [];
    try { scopes = JSON.parse(String(r.scopes)); } catch { /* empty */ }
    // 刷新 last_used_at，但按 isolate 内存做 60s 节流，避免每个请求一次写库
    const nowMs = Date.now();
    const last = apiKeyUseCache.get(hash) ?? 0;
    if (nowMs - last > 60_000) {
      apiKeyUseCache.set(hash, nowMs);
      void store.touchApiKey(env, hash);
    }
    return { admin: false, scopes: new Set(scopes) };
  }

  // Session cookie
  const cookieHeader = request.headers.get('Cookie') || '';
  const match = /(?:^|;\s*)cdt_session=([^;]+)/.exec(cookieHeader);
  if (!match) return null;
  const hash = await tokenHash(match[1]);
  const row = await env.DB.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').bind(hash).first();
  if (!row) return null;
  const expiresAt = new Date(String((row as Record<string, unknown>).expires_at));
  if (expiresAt.getTime() < Date.now()) return null;
  return { admin: true, scopes: new Set(['admin', 'widget:read', 'instance:control', 'cron:run']) };
}

// 路由表
const routes: { method: string; pattern: string; scope?: string; handler: (ctx: Context) => Promise<Response> }[] = [
  { method: 'GET', pattern: '/healthz', handler: async () => json({ status: 'ok' }) },
  { method: 'GET', pattern: '/readyz', handler: async (ctx) => {
      try { await ctx.env.DB.prepare('SELECT 1').first(); return json({ status: 'ready' }); }
      catch { return error('database_not_ready', 'database not ready', 503); }
    } },
  // 未鉴权接口：只暴露「是否已初始化」。
  // 注意：不要在这里返回 ADMIN_PASSWORD 是否存在（envPasswordSet）——
  // 那等于向匿名访客泄露后门是否启用，属于情报泄露。该信息只对
  // 「已经尝试过登录的人」披露（见 login 失败响应里的 env_password_available）。
  { method: 'GET', pattern: '/api/v1/system/init-status', handler: async (ctx) => json({
      initialized: await store.isInitialized(ctx.env),
    }) },
  { method: 'GET', pattern: '/api/v1/system/triggers', scope: 'admin', handler: getTriggers },
  { method: 'PUT', pattern: '/api/v1/system/triggers', scope: 'admin', handler: saveTriggers },
  { method: 'POST', pattern: '/api/v1/system/triggers/test', scope: 'admin', handler: testTrigger },
  { method: 'GET', pattern: '/api/v1/system/cron-secret', scope: 'admin', handler: getCronSecretHandler },
  { method: 'PUT', pattern: '/api/v1/system/cron-secret', scope: 'admin', handler: setCronSecretHandler },
  // 下载自建驱动脚本（driver.mjs / install.sh），配置通过查询参数注入
  { method: 'GET', pattern: '/api/v1/system/selfhost/driver', scope: 'admin', handler: selfhostDownload },
  // 无 scope：供外部触发源（GitHub Actions / 自建驱动）在调用前查开关，内部自行鉴权
  { method: 'GET', pattern: '/api/v1/system/trigger-status', handler: triggerStatus },
  { method: 'POST', pattern: '/api/v1/setup', handler: setup },
  { method: 'POST', pattern: '/api/v1/auth/login', handler: login },
  { method: 'POST', pattern: '/api/v1/auth/password', scope: 'admin', handler: changePassword },
  { method: 'POST', pattern: '/api/v1/auth/logout', scope: 'admin', handler: logout },
  { method: 'GET', pattern: '/api/v1/status', scope: 'widget:read', handler: statusHandler },
  { method: 'GET', pattern: '/api/v1/widget/summary', scope: 'widget:read', handler: widgetSummary },
  { method: 'GET', pattern: '/api/v1/config', scope: 'admin', handler: getConfig },
  { method: 'PUT', pattern: '/api/v1/config', scope: 'admin', handler: saveConfig },
  { method: 'GET', pattern: '/api/v1/accounts/:id/history', scope: 'widget:read', handler: historyHandler },
  { method: 'POST', pattern: '/api/v1/accounts/:id/refresh', scope: 'instance:control', handler: refresh },
  { method: 'POST', pattern: '/api/v1/accounts/:id/actions/:action', scope: 'instance:control', handler: controlHandler },
  { method: 'DELETE', pattern: '/api/v1/accounts/:id', scope: 'admin', handler: deleteAccountHandler },
  { method: 'GET', pattern: '/api/v1/logs', scope: 'admin', handler: logsHandler },
  { method: 'DELETE', pattern: '/api/v1/logs', scope: 'admin', handler: clearLogsHandler },
  { method: 'POST', pattern: '/api/v1/notify/test', scope: 'admin', handler: notifyTestHandler },
  { method: 'GET', pattern: '/api/v1/system/api-keys', scope: 'admin', handler: listApiKeysHandler },
  { method: 'POST', pattern: '/api/v1/system/api-keys', scope: 'admin', handler: createApiKeyHandler },
  { method: 'DELETE', pattern: '/api/v1/system/api-keys/:id', scope: 'admin', handler: deleteApiKeyHandler },
  // ── DDNS 轮换解析 ──
  { method: 'GET', pattern: '/api/v1/ddns/overview', scope: 'admin', handler: ddnsOverview },
  { method: 'POST', pattern: '/api/v1/ddns/machines', scope: 'admin', handler: ddnsCreateMachine },
  { method: 'PUT', pattern: '/api/v1/ddns/machines/:id', scope: 'admin', handler: ddnsUpdateMachine },
  { method: 'DELETE', pattern: '/api/v1/ddns/machines/:id', scope: 'admin', handler: ddnsDeleteMachine },
  { method: 'POST', pattern: '/api/v1/ddns/groups', scope: 'admin', handler: ddnsCreateGroup },
  { method: 'PUT', pattern: '/api/v1/ddns/groups/:id', scope: 'admin', handler: ddnsUpdateGroup },
  { method: 'DELETE', pattern: '/api/v1/ddns/groups/:id', scope: 'admin', handler: ddnsDeleteGroup },
  { method: 'PUT', pattern: '/api/v1/ddns/groups/:id/members', scope: 'admin', handler: ddnsSaveMembers },
  { method: 'POST', pattern: '/api/v1/ddns/records', scope: 'admin', handler: ddnsCreateRecord },
  { method: 'PUT', pattern: '/api/v1/ddns/records/:id', scope: 'admin', handler: ddnsUpdateRecord },
  { method: 'DELETE', pattern: '/api/v1/ddns/records/:id', scope: 'admin', handler: ddnsDeleteRecord },
  { method: 'POST', pattern: '/api/v1/ddns/sync', scope: 'admin', handler: ddnsSyncHandler },
  { method: 'GET', pattern: '/api/v1/ddns/preview', scope: 'admin', handler: ddnsPreviewHandler },
];

async function setup(ctx: Context): Promise<Response> {
  if (!allowRate('setup:' + clientIP(ctx.request), 5, 60_000)) {
    return error('rate_limited', '请求过于频繁', 429);
  }
  const body = await ctx.request.json().catch(() => null);
  if (!body || typeof body !== 'object') return error('invalid_request', 'invalid JSON', 400);
  const b = body as Record<string, unknown>;
  const password = String(b.password ?? '');
  if (password.length < 10) return error('invalid_password', '密码至少需要 10 个字符', 400);
  if (await store.isInitialized(ctx.env)) return error('already_initialized', '系统已初始化', 400);
  const hash = await hashPassword(password);
  await store.setPasswordHash(ctx.env, hash);
  await store.addLog(ctx.env, 'audit', '系统初始化完成 [IP: ' + clientIP(ctx.request) + ']');
  const { token, csrf } = await createSession(ctx.env, ctx.request);
  return setAuthCookies(json({ success: true, csrf_token: csrf }, 201), token, csrf, ctx.request);
}

// 登录失败窗口（15 分钟）内的最大失败次数（D1 计数，跨 isolate 生效）
const LOGIN_MAX_FAILURES = 8;

async function recentLoginFailures(env: Env, ip: string): Promise<number> {
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND created_at >= datetime('now','-15 minutes')",
    ).bind(ip).first();
    return row ? Number((row as Record<string, unknown>).c ?? 0) : 0;
  } catch { return 0; } // 计数失败不应阻断登录主流程（退化为仅内存限流）
}

async function clearLoginFailures(env: Env, ip: string): Promise<void> {
  try {
    await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  } catch { /* 清理失败不影响登录 */ }
}

async function login(ctx: Context): Promise<Response> {
  const ip = clientIP(ctx.request);
  // 第一道：单 isolate 内存限流（快、零成本）
  if (!allowRate('login:' + ip, 8, 15 * 60_000)) {
    return error('rate_limited', '登录尝试过多，请稍后再试', 429);
  }
  // 第二道：D1 计数（跨 isolate 生效，Cloudflare 会调度到多个实例，内存计数会失效）
  const failures = await recentLoginFailures(ctx.env, ip);
  if (failures >= LOGIN_MAX_FAILURES) {
    await store.addLog(ctx.env, 'warning', `登录尝试过多已拦截 [IP: ${ip}]（15 分钟内失败 ${failures} 次）`);
    return error('rate_limited', '登录尝试过多，请 15 分钟后再试', 429);
  }
  const body = await ctx.request.json().catch(() => null);
  const password = String((body as Record<string, unknown>)?.password ?? '');
  if (!password) return error('invalid_credentials', '请输入密码', 400);

  const storedHash = await store.getPasswordHash(ctx.env);
  let valid = storedHash ? await verifyPassword(storedHash, password) : false;
  let viaEnvPassword = false;

  // 兜底：Cloudflare 环境变量 ADMIN_PASSWORD（忘记密码时的恢复入口）
  if (!valid) {
    const fallback = envPassword(ctx.env);
    if (fallback && (await constantTimeEqual(fallback, password))) {
      valid = true;
      viaEnvPassword = true;
    }
  }

  if (!valid) {
    await ctx.env.DB.prepare('INSERT INTO login_attempts (ip) VALUES (?)').bind(ip).run();
    await store.addLog(ctx.env, 'warning', '管理员登录失败 [IP: ' + ip + ']');
    // 登录失败响应是攻击者完全可控的路径，绝不能在此处广播 ADMIN_PASSWORD 是否已设置
    // （等于持续通报"后门是否开启"）。可用性只在成功登录的响应里返回。
    return json({
      error: { code: 'invalid_credentials', message: '密码错误' },
      env_password_available: false,
    }, 401);
  }

  // 用环境变量密码登录成功：回写 D1 哈希，使密码与会话状态一致
  if (viaEnvPassword) {
    // 短密码不回写哈希会造成"双密码体系"：用户以为换成功，旧的 D1 哈希依然有效 → 影子后门。
    // 直接拒绝，逼用户把 ADMIN_PASSWORD 设成 >=10 位，杜绝该分支。
    if (password.length < 10) {
      await store.addLog(ctx.env, 'audit',
        'ADMIN_PASSWORD 长度不足 10 位，拒绝用于登录 [IP: ' + ip + ']。'
        + '请到 Cloudflare Dashboard 把 ADMIN_PASSWORD 改为 10 位以上后重试');
      return error('weak_env_password',
        'ADMIN_PASSWORD 长度不足 10 位，拒绝使用该凭据登录；请到 Cloudflare Dashboard 修改 ADMIN_PASSWORD 为 10 位以上后重试。',
        400);
    }
    await store.setPasswordHash(ctx.env, await hashPassword(password));
    await store.addLog(ctx.env, 'audit',
      '使用环境变量 ADMIN_PASSWORD 登录成功，管理员密码已同步为该值 [IP: ' + ip + ']。'
      + '建议尽快到 Cloudflare Dashboard 删除 ADMIN_PASSWORD 环境变量——'
      + '留着它等于永久保留一个明文后门，任何人拿到该值即可进入系统');
  }

  const { token, csrf } = await createSession(ctx.env, ctx.request);
  // 登录成功：清空该 IP 的失败记录，避免历史失败累计误伤正常登录
  await clearLoginFailures(ctx.env, ip);
  if (!viaEnvPassword) await store.addLog(ctx.env, 'audit', '管理员登录成功 [IP: ' + ip + ']');
  return setAuthCookies(json({ success: true, csrf_token: csrf, via_env_password: viaEnvPassword }, 200), token, csrf, ctx.request);
}

// 修改管理员密码：校验当前密码（D1 哈希或环境变量密码均可），成功后吊销其他会话
async function changePassword(ctx: Context): Promise<Response> {
  if (!allowRate('passwd:' + clientIP(ctx.request), 6, 15 * 60_000)) {
    return error('rate_limited', '操作过于频繁，请稍后再试', 429);
  }
  const body = await ctx.request.json().catch(() => null);
  if (!body || typeof body !== 'object') return error('invalid_request', 'invalid JSON', 400);
  const b = body as Record<string, unknown>;
  const currentPassword = String(b.currentPassword ?? '');
  const newPassword = String(b.newPassword ?? '');

  if (newPassword.length < 10) return error('invalid_password', '新密码至少需要 10 个字符', 400);
  if (newPassword.length > 128) return error('invalid_password', '新密码不能超过 128 个字符', 400);
  if (!currentPassword) return error('invalid_password', '请输入当前密码', 400);
  if (newPassword === currentPassword) return error('invalid_password', '新密码不能与当前密码相同', 400);

  const storedHash = await store.getPasswordHash(ctx.env);
  let valid = storedHash ? await verifyPassword(storedHash, currentPassword) : false;
  if (!valid) {
    const fallback = envPassword(ctx.env);
    if (fallback && (await constantTimeEqual(fallback, currentPassword))) valid = true;
  }
  if (!valid) {
    await store.addLog(ctx.env, 'warning', '修改管理员密码失败：当前密码错误 [IP: ' + clientIP(ctx.request) + ']');
    return error('invalid_credentials', '当前密码错误', 401);
  }

  await store.setPasswordHash(ctx.env, await hashPassword(newPassword));

  // 吊销其他设备上的会话，仅保留当前会话
  const cookieHeader = ctx.request.headers.get('Cookie') || '';
  const match = /(?:^|;\s*)cdt_session=([^;]+)/.exec(cookieHeader);
  if (match) {
    const currentHash = await tokenHash(match[1]);
    await ctx.env.DB.prepare('DELETE FROM sessions WHERE token_hash != ?').bind(currentHash).run();
  } else {
    await ctx.env.DB.prepare('DELETE FROM sessions').run();
  }

  await store.addLog(ctx.env, 'audit', '管理员修改了登录密码，其他设备会话已失效 [IP: ' + clientIP(ctx.request) + ']');
  return json({ success: true, message: '密码已更新，其他设备需重新登录' });
}

async function logout(ctx: Context): Promise<Response> {
  const cookieHeader = ctx.request.headers.get('Cookie') || '';
  const match = /(?:^|;\s*)cdt_session=([^;]+)/.exec(cookieHeader);
  if (match) {
    const hash = await tokenHash(match[1]);
    await ctx.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
  }
  const headers = new Headers({ 'Content-Type': 'application/json' });
  // 必须 append 两次，不能逗号拼接成一个 Set-Cookie 头（否则浏览器只清掉第一个 cookie）
  headers.append('Set-Cookie', 'cdt_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict');
  headers.append('Set-Cookie', 'cdt_csrf=; Path=/; Max-Age=0; SameSite=Strict');
  return new Response(JSON.stringify({ success: true }), { status: 200, headers });
}

async function createSession(env: Env, request: Request): Promise<{ token: string; csrf: string }> {
  const token = newToken(32);
  const csrf = newToken(24);
  const hash = await tokenHash(token);
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (token_hash, ip, user_agent, expires_at) VALUES (?,?,?,?)')
    .bind(hash, clientIP(request), request.headers.get('User-Agent') || '', expiresAt).run();
  return { token, csrf };
}

function setAuthCookies(response: Response, token: string, csrf: string, request: Request): Response {
  const headers = new Headers(response.headers);
  const secure = request.url.startsWith('https://');
  headers.append('Set-Cookie', `cdt_session=${token}; Path=/; HttpOnly; ${secure ? 'Secure; ' : ''}SameSite=Strict; Max-Age=86400`);
  headers.append('Set-Cookie', `cdt_csrf=${csrf}; Path=/; ${secure ? 'Secure; ' : ''}SameSite=Strict; Max-Age=86400`);
  return new Response(response.body, { status: response.status, headers });
}

async function statusHandler(ctx: Context): Promise<Response> {
  const accounts = await engine.summary(ctx.env);
  return json({ accounts });
}

async function widgetSummary(ctx: Context): Promise<Response> {
  const accounts = await engine.summary(ctx.env);
  return json({ accounts: accounts.map((a) => ({ id: a.id, name: a.name, status: a.status, used: a.used, total: a.total, percentage: a.percentage, updated_at: a.updatedAt })) });
}

async function getConfig(ctx: Context): Promise<Response> {
  const config = await store.getConfig(ctx.env);
  // 脱敏：不返回密码哈希、加密 secret 明文与通知通道密钥（只回 configured 标志）
  const n = config.notifications;
  const safe = {
    trafficThreshold: config.trafficThreshold,
    shutdownMode: config.shutdownMode,
    thresholdAction: config.thresholdAction,
    apiInterval: config.apiInterval,
    monitorInterval: config.monitorInterval,
    timezone: config.timezone,
    keepAlive: config.keepAlive,
    enableBilling: config.enableBilling,
    enableScheduleMail: config.enableScheduleMail,
    enableStatusChangeNotify: config.enableStatusChangeNotify,
    logRetentionDays: config.logRetentionDays,
    // 每个通道用空对象兜底：即使 D1 里的旧配置缺某个通道键也不会抛错
    notifications: {
      telegram: { ...(n.telegram ?? {}), token: '', tokenConfigured: !!n.telegram?.token },
      webhook: { ...(n.webhook ?? {}), secret: '', secretConfigured: !!n.webhook?.secret },
      serverchan: { ...(n.serverchan ?? {}), sendKey: '', sendKeyConfigured: !!n.serverchan?.sendKey },
      pushplus: { ...(n.pushplus ?? {}), token: '', tokenConfigured: !!n.pushplus?.token },
      smtp: { ...(n.smtp ?? {}), password: '', passwordConfigured: !!n.smtp?.password },
      template: { body: n.template?.body ?? '' },
    },
    // AccessKey ID 非敏感信息（Secret 才是），明文返回供界面展示与编辑；
    // AccessKey Secret 仍不回传，仅通过 configured 方式提示
    accounts: config.accounts.map((a) => ({ ...a, accessKeySecret: '' })),
  };
  return json(safe);
}

// 通知通道的敏感字段：新值为空串时继承旧值（前端脱敏显示后原样提交的场景）
function mergeNotifySecrets(prev: Record<string, Record<string, unknown>> | undefined, next: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  const secretPaths: [string, string, string][] = [
    ['telegram', 'token', 'tokenConfigured'],
    ['webhook', 'secret', 'secretConfigured'],
    ['serverchan', 'sendKey', 'sendKeyConfigured'],
    ['pushplus', 'token', 'tokenConfigured'],
    ['smtp', 'password', 'passwordConfigured'],
  ];
  for (const [chan, field, flag] of secretPaths) {
    const incoming = next[chan];
    if (!incoming || typeof incoming !== 'object') continue;
    if (incoming[field] === '' && prev?.[chan]?.[field]) {
      incoming[field] = prev[chan][field];
    }
    delete incoming[flag]; // configured 标志不落库
  }
  // 自定义模板同理：前端保存时把正文置空提交，若不继承旧值就会把用户辛苦写的模板清空。
  const nextTemplate = next.template;
  if (nextTemplate && typeof nextTemplate === 'object') {
    const incomingBody = String(nextTemplate.body ?? '');
    if (incomingBody.trim() === '' && prev?.template && typeof prev.template === 'object') {
      const oldBody = String(prev.template.body ?? '');
      if (oldBody) nextTemplate.body = oldBody;
    }
  }
  return next;
}

async function saveConfig(ctx: Context): Promise<Response> {
  const body = await ctx.request.json().catch(() => null);
  if (!body || typeof body !== 'object') return error('invalid_request', 'invalid JSON', 400);
  const b = body as Record<string, unknown>;

  // 数值白名单校验：直接 `parseInt(x) || default` 会被 "-50"/"1e9" 之类的脏值穿透
  // （parseInt('1e9') === 1，parseInt('-50') === -50），threshold=-50 会让
  // `percentage >= threshold` 恒真，触发 stop_and_notify 批量停掉所有在线实例。
  // 这里在写库前统一校验并夹取，越界直接拒绝，不给脏值落库的机会。
  // 语义（见 store.parseClampedNum）：未传(undefined/null/'') → fallback 放行，
  // 是否落库由下方「显式传入才写」的各自分支决定；非法/越界 → null → 400。
  // ⚠️ 两条路径绝不能共用哨兵值：542c57a 曾把 logRetentionDays 的「未传」映射成
  // null 与非法值合并判断，导致所有不带该字段的保存（含账号配置）全部 400。
  const trafficThreshold = store.parseClampedNum(b.trafficThreshold, 1, 100, 90);
  if (trafficThreshold === null) return error('invalid_input', '流量阈值必须在 1~100 之间', 400);
  const apiInterval = store.parseClampedNum(b.apiInterval, 60, 86400, 600);
  if (apiInterval === null) return error('invalid_input', 'API 刷新间隔必须在 60~86400 秒之间', 400);
  const monitorInterval = store.parseClampedNum(b.monitorInterval, 1, 1440, 5);
  if (monitorInterval === null) return error('invalid_input', '监控间隔必须在 1~1440 分钟之间', 400);
  const logRetentionDays = store.parseClampedNum(b.logRetentionDays, 1, 365, 30);
  if (logRetentionDays === null) return error('invalid_input', '日志保留天数必须在 1~365 之间', 400);

  // 字符串白名单校验：这几个值会直接进分支判断或时区格式化，非法值常不报错（被 try/catch
  // 吞掉回退），只表现为「功能悄悄不对」——例如非法时区被 time.ts 回退到 UTC，会让
  // 定时开关机整体偏移 8 小时，用户只能看到「定时不准」却无从自查。写库前统一拦截。
  if (b.timezone !== undefined) {
    const tz = String(b.timezone).trim();
    const tzOk = tz !== '' && (() => {
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
      catch { return false; }
    })();
    if (!tzOk) return error('invalid_input', '时区无效，请使用 IANA 时区名（如 Asia/Shanghai）', 400);
  }
  const SHUTDOWN_MODES = ['StopCharging', 'KeepCharging'];
  if (b.shutdownMode !== undefined && !SHUTDOWN_MODES.includes(String(b.shutdownMode))) {
    return error('invalid_input', `停机模式必须是 ${SHUTDOWN_MODES.join(' / ')}`, 400);
  }
  const THRESHOLD_ACTIONS = ['stop_and_notify', 'notify_only'];
  if (b.thresholdAction !== undefined && !THRESHOLD_ACTIONS.includes(String(b.thresholdAction))) {
    return error('invalid_input', `阈值动作必须是 ${THRESHOLD_ACTIONS.join(' / ')}`, 400);
  }

  // 仅写入请求中显式传入的设置项：添加账号只传 accounts 时不会重置其他参数
  const optionalSettings: [string, unknown, string][] = [
    ['traffic_threshold', b.trafficThreshold, String(trafficThreshold)],
    ['shutdown_mode', b.shutdownMode, String(b.shutdownMode ?? 'StopCharging')],
    ['threshold_action', b.thresholdAction, String(b.thresholdAction ?? 'stop_and_notify')],
    ['api_interval', b.apiInterval, String(apiInterval)],
    ['monitor_interval', b.monitorInterval, String(monitorInterval)],
    ['timezone', b.timezone, String(b.timezone ?? 'Asia/Shanghai')],
    ['keep_alive', b.keepAlive, b.keepAlive ? '1' : '0'],
    ['enable_billing', b.enableBilling, b.enableBilling ? '1' : '0'],
    ['enable_schedule_mail', b.enableScheduleMail, b.enableScheduleMail ? '1' : '0'],
    ['enable_status_change_notify', b.enableStatusChangeNotify, b.enableStatusChangeNotify ? '1' : '0'],
  ];
  const settings: [string, string][] = [];
  for (const [key, present, value] of optionalSettings) {
    if (present !== undefined) settings.push([key, value]);
  }
  // logRetentionDays 仅在显式传入时才写入，避免设置页保存时误重置
  if (b.logRetentionDays !== undefined) {
    settings.push(['log_retention_days', String(logRetentionDays)]);
  }
  // 多条 settings 写入合并成一次 DB.batch（batch 只算 1 个 subrequest，逐个 run() 是 N 个）
  if (settings.length > 0) {
    await ctx.env.DB.batch(
      settings.map(([k, v]) =>
        ctx.env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').bind(k, v),
      ),
    );
  }
  if (b.notifications) {
    // 敏感字段空串继承旧值，configured 标志不入库
    let merged = b.notifications as Record<string, Record<string, unknown>>;
    try {
      const oldRaw = await ctx.env.DB.prepare("SELECT value FROM settings WHERE key = 'notifications'").first();
      const old = oldRaw ? JSON.parse(String((oldRaw as Record<string, unknown>).value ?? '{}')) : undefined;
      merged = mergeNotifySecrets(old, merged);
    } catch {
      merged = mergeNotifySecrets(undefined, merged);
    }
    // 敏感字段（telegram token / smtp password / webhook secret 等）落库前 AES-GCM 加密，
    // 与 AK/SK 同等强度，避免 D1 备份/导出泄露通知渠道凭据。encryptNotifyConfig 幂等，
    // 已加密值跳过；旧库明文在本次保存时自动升级为密文。
    merged = await store.encryptNotifyConfig(ctx.env, merged as unknown as Record<string, unknown>) as Record<string, Record<string, unknown>>;
    await ctx.env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,datetime('now'))")
      .bind('notifications', JSON.stringify(merged)).run();
  }
  // 保存账号：带 id 走更新（AK/SK 留空=保持不变），无 id 且提供 AK/SK 才新增
  if (Array.isArray(b.accounts)) {
    for (const a of b.accounts as Partial<Account>[]) {
      if (a.id) {
        await store.updateAccountConfig(ctx.env, a as Partial<Account> & { id: number });
      } else if (a.accessKeySecret && a.accessKeyId) {
        await store.saveAccount(ctx.env, a as Omit<Account, 'id'> & { id?: number });
      }
    }
  }
  await store.addLog(ctx.env, 'audit', '管理员更新系统配置');
  return json({ success: true });
}

async function historyHandler(ctx: Context): Promise<Response> {
  const id = parseInt(ctx.params.id, 10);
  return json(await store.history(ctx.env, id));
}

async function refresh(ctx: Context): Promise<Response> {
  const id = parseInt(ctx.params.id, 10);
  const config = await store.getConfig(ctx.env);
  const account = config.accounts.find((a) => a.id === id);
  if (!account) return error('account_not_found', '账号不存在', 404);

  // 该接口走 force=true，绕过 runMonitorCycle 的防抖与槽位抢占，连点即可把阿里云 RPC
  // 和通知通道打爆（会触发 Throttling.User 并污染其它账号）。按账号做分钟级节流。
  const minuteKey = 'refresh:' + id + ':' + minuteStamp();
  if (!(await store.recordActionEvent(ctx.env, minuteKey, id, 'refresh', 'attempting', ''))) {
    return error('too_many_requests', '刷新过于频繁，请 1 分钟后再试', 429);
  }

  const result = await engine.processAccount(ctx.env, account, true);
  return json({ job: result }, 202);
}

// "YYYYMMDDHHmm"，用于各类分钟/小时级幂等键与限流键
function minuteStamp(now = new Date()): string {
  return now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
}

async function controlHandler(ctx: Context): Promise<Response> {
  // 限流：control 会真实调用阿里云启停 API，连点等于把实例反复启停 + 打爆 RPC。
  // 与 refresh 同口径按账号做分钟级节流。
  const id = parseInt(ctx.params.id, 10);
  const action = ctx.params.action as 'start' | 'stop';
  if (action !== 'start' && action !== 'stop') return error('invalid_action', 'action must be start or stop', 400);
  if (!allowRate('control:' + clientIP(ctx.request), 10, 60_000)) {
    return error('rate_limited', '操作过于频繁，请 1 分钟后再试', 429);
  }
  const message = await engine.control(ctx.env, id, action, '手动');
  return json({ success: true, message }, 202);
}

async function logsHandler(ctx: Context): Promise<Response> {
  const url = new URL(ctx.request.url);
  const category = url.searchParams.get('category') || 'all';
  const page = parseInt(url.searchParams.get('page') || '1', 10) || 1;
  const pageSize = parseInt(url.searchParams.get('pageSize') || '50', 10) || 50;
  const data = await store.listLogs(ctx.env, category, page, pageSize);
  // D1 的 created_at 是 UTC（datetime('now')），按配置时区转换为本地时间字符串展示。
  // 这里只需一个 timezone 字符串，单行查询即可，不必为了它做全量 getConfig（会解密所有账号 AK/SK）。
  let tz = (await store.getSetting(ctx.env, 'timezone')) || 'Asia/Shanghai';
  const logs = data.logs.map((l) => ({ ...l, created_at: toZoneString(l.created_at, tz) }));
  return json({ ...data, logs, timezone: tz });
}

// 把 "YYYY-MM-DD HH:mm:ss"（UTC）转为指定时区的同格式字符串。
// 复用 time.ts 的 formatter 缓存——日志页每页 50 条，原来要 new 50 次 Intl.DateTimeFormat（毫秒级）。
function toZoneString(utc: string, timezone: string): string {
  if (!utc) return utc;
  const ms = Date.parse(utc.replace(' ', 'T') + 'Z');
  if (isNaN(ms)) return utc;
  return formatWallClock(new Date(ms), timezone);
}

// ---------- API Keys（只读展示 / 创建 / 吊销） ----------
// 与路由表中实际引用的 scope 保持一致（未使用的 scope 不列出，避免再造一个死权限）
const API_KEY_SCOPES = ['widget:read', 'instance:control'];

async function listApiKeysHandler(ctx: Context): Promise<Response> {
  const keys = await store.listApiKeys(ctx.env);
  return json({ keys, scopes: API_KEY_SCOPES });
}

async function createApiKeyHandler(ctx: Context): Promise<Response> {
  if (!allowRate('apikey:' + clientIP(ctx.request), 10, 60_000)) {
    return error('rate_limited', '操作过于频繁，请稍后再试', 429);
  }
  const body = await ctx.request.json().catch(() => null);
  if (!body || typeof body !== 'object') return error('invalid_request', 'invalid JSON', 400);
  const b = body as Record<string, unknown>;

  const name = String(b.name ?? '').trim().slice(0, 40);
  if (!name) return error('invalid_request', '请填写名称', 400);

  const rawScopes = Array.isArray(b.scopes) ? b.scopes.map((s) => String(s)) : [];
  // 白名单过滤：未知 scope 直接丢弃，避免自建 key 声明不存在的权限造成误导
  const scopes = rawScopes.filter((s) => API_KEY_SCOPES.includes(s));
  if (scopes.length === 0) {
    return error('invalid_request', '请至少选择一个有效权限：' + API_KEY_SCOPES.join(' / '), 400);
  }

  let expiresAt: string | null = null;
  if (b.expiresDays != null && b.expiresDays !== '') {
    const days = parseInt(String(b.expiresDays), 10);
    if (Number.isFinite(days) && days > 0) {
      expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
    }
  }

  const tokenPlain = 'cdt_' + newToken(24);
  const hash = await tokenHash(tokenPlain);
  await store.createApiKey(ctx.env, name, scopes, expiresAt, tokenPlain, hash);
  await store.addLog(ctx.env, 'audit', '创建 API Key：' + name + ' [' + scopes.join(',') + ']');
  // 明文仅在本次响应返回，服务端不再保存
  return json({ success: true, token: tokenPlain, name, scopes, expires_at: expiresAt }, 201);
}

async function deleteApiKeyHandler(ctx: Context): Promise<Response> {
  if (!allowRate('apikey-del:' + clientIP(ctx.request), 20, 60_000)) {
    return error('rate_limited', '操作过于频繁，请稍后再试', 429);
  }
  const id = parseInt(ctx.params.id, 10);
  if (!Number.isFinite(id)) return error('invalid_request', 'id 无效', 400);
  const ok = await store.deleteApiKey(ctx.env, id);
  if (!ok) return error('not_found', 'API Key 不存在或已删除', 404);
  await store.addLog(ctx.env, 'audit', '吊销 API Key：#' + id);
  return json({ success: true });
}

async function clearLogsHandler(ctx: Context): Promise<Response> {
  if (!allowRate('clearlogs:' + clientIP(ctx.request), 10, 60_000)) {
    return error('rate_limited', '清空日志过于频繁，请 1 分钟后再试', 429);
  }
  const category = new URL(ctx.request.url).searchParams.get('category') || 'all';
  await store.clearLogs(ctx.env, category);
  return json({ success: true });
}

// 测试通知：向所有已启用通道发送一条测试消息
async function notifyTestHandler(ctx: Context): Promise<Response> {
  // 限流：测试会真实调用所有已启用的通知通道（telegram/webhook/smtp 等），
  // 连点等于给第三方通道刷消息、甚至触发其限流封禁。
  if (!allowRate('notify-test:' + clientIP(ctx.request), 5, 60_000)) {
    return error('rate_limited', '测试过于频繁，请 1 分钟后再试', 429);
  }
  const config = await store.getConfig(ctx.env);
  let channel = '';
  let accountId = 0;
  try {
    const body = await ctx.request.json().catch(() => null);
    channel = String((body as Record<string, unknown>)?.channel ?? '').trim();
    accountId = Math.floor(Number((body as Record<string, unknown>)?.accountId ?? 0)) || 0;
  } catch { /* 无 body 则测全部 */ }
  const validChannels = ['telegram', 'webhook', 'serverchan', 'pushplus', 'smtp'];
  if (channel && validChannels.indexOf(channel) < 0) return error('invalid_channel', '未知的通知通道', 400);
  // 示例账号：指定 accountId 用该账号渲染；未指定用第一个（此前写死第一个账号，
  // 多账号时无法验证其他账号的通知内容）
  let sample = config.accounts[0];
  if (accountId) {
    const found = config.accounts.find((a) => a.id === accountId);
    if (!found) return error('account_not_found', '所选账号不存在，请刷新页面后重试', 404);
    sample = found;
  }
  const fields: Record<string, string> = {
    '时间': new Date().toLocaleString('zh-CN', { timeZone: config.timezone || 'Asia/Shanghai' }),
    '时区': config.timezone || 'Asia/Shanghai',
    '阈值': `${config.trafficThreshold}%`,
  };
  if (sample) {
    const used = sample.trafficUsed ?? 0;
    const total = sample.maxTraffic ?? 0;
    const pct = total > 0 ? (used / total) * 100 : 0;
    Object.assign(fields, {
      '账号': sample.accessKeyId ? sample.accessKeyId.slice(0, 7) + '***' : '',
      '机器名': sample.remark || sample.name || '',
      '备注': sample.remark || '',
      '地区': sample.regionId || '',
      '地域ID': sample.regionId || '',
      '实例': sample.instanceId || '',
      '停机模式': config.shutdownMode === 'StopCharging' ? '节省停机' : '普通停机',
      '开机时间': sample.scheduleEnabled ? (sample.startTime || '08:00') : '未启用',
      '关机时间': sample.scheduleEnabled ? (sample.stopTime || '23:00') : '未启用',
      '已用流量': `${used.toFixed(2)} GB`,
      '流量上限': `${total.toFixed(2)} GB`,
      '剩余流量': `${Math.max(0, total - used).toFixed(2)} GB`,
      '使用率': `${pct.toFixed(2)}%`,
      '实例状态': sample.instanceStatus || 'Unknown',
      '账户余额': '',
      '使用金额': '',
    });
  }
  const event = {
    id: newToken(18),
    type: 'test',
    title: '通知通道测试',
    summary: '这是一条来自 CDT Monitor 的测试通知，收到即代表该通道配置正确。',
    accountId: sample ? sample.id : 0,
    fields,
    createdAt: new Date().toISOString(),
  };
  const results = await deliverEvent(config.notifications as never, event as never, channel);
  if (channel && results.length === 0) return error('channel_not_enabled', '该通道未启用或未完整配置，请先保存', 400);
  if (results.length === 0) return error('no_channel', '尚未启用任何通知通道，请先开启并保存', 400);
  return json({ results });
}

async function deleteAccountHandler(ctx: Context): Promise<Response> {
  // 限流：删除账号是破坏性操作，防误触连点。
  if (!allowRate('delete-account:' + clientIP(ctx.request), 10, 60_000)) {
    return error('rate_limited', '操作过于频繁，请 1 分钟后再试', 429);
  }
  const id = parseInt(ctx.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) return error('invalid_input', '账号 ID 无效', 400);
  await store.deleteAccount(ctx.env, id);
  await store.addLog(ctx.env, 'audit', '删除账号 #' + id);
  return json({ success: true });
}

// 路径匹配
function matchRoute(method: string, pathname: string): { route: (typeof routes)[number]; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const patternParts = route.pattern.split('/');
    const pathParts = pathname.split('/');
    if (patternParts.length !== pathParts.length) continue;
    const params: Record<string, string> = {};
    let match = true;
    for (let i = 0; i < patternParts.length; i++) {
      const p = patternParts[i];
      const q = pathParts[i];
      if (p.startsWith(':')) {
        // 畸形百分号编码（如 %ZZ）会让 decodeURIComponent 抛 URIError，这里容错为不匹配，
        // 避免单请求导致 Worker 500（此前该异常在 try/catch 之外直接冒泡）
        try {
          params[p.slice(1)] = decodeURIComponent(q);
        } catch {
          match = false;
          break;
        }
      } else if (p !== q) { match = false; break; }
    }
    if (match) return { route, params };
  }
  return null;
}

// 安全响应头：SPA 已 100% 转义，XSS 风险低，但补齐这些头成本近乎为零。
// 注意：直接在原响应头对象上 set，不再 new Response 重包 body ——
// 重包会触发两次 body 流搬运，在 10ms CPU 预算下是白给的开销。
function withSecurityHeaders(resp: Response, request: Request): Response {
  const headers = new Headers(resp.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // CSP 只给 HTML 页面：API 响应加它只会徒增负担
  if ((headers.get('Content-Type') || '').includes('text/html') && !headers.has('Content-Security-Policy')) {
    headers.set('Content-Security-Policy', [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",      // 单文件 SPA 内联脚本
      "style-src 'self' 'unsafe-inline'",       // 运行时注入的样式
      "img-src 'self' data:",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "object-src 'none'",
    ].join('; '));
  }
  if (request.url.startsWith('https://')) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}

export async function handleRequest(env: Env, request: Request): Promise<Response> {
  // 统一出口包一层安全响应头，避免每个分支各自维护
  return withSecurityHeaders(await route(env, request), request);
}

async function route(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Cron 触发器（监控循环）
  // 双通道鉴权：外部定时服务用 CRON_SECRET（仅认 X-Cron-Secret 请求头）；
  // 管理台「立即监控」按钮走管理员会话 cookie。未配置 CRON_SECRET 时仅放行管理员会话，
  // 避免 /__cron 回归公开可刷（放大阿里云 API 调用与 D1 写入）。
  // 安全：不再接受 ?key= 查询参数——查询串会被 CF 日志/Logpush 原样留存，等于泄露密钥。
  if (request.headers.get('X-Cron-Trigger') === 'true' || url.pathname === '/__cron') {
    // 密钥支持 D1 托管（管理台可查看/修改）与 Worker Secret 两个来源
    const expected = await store.resolveCronSecret(env);
    let authorized = false;
    let viaSecret = false;
    if (expected) {
      const provided = request.headers.get('X-Cron-Secret') || '';
      authorized = !!provided && (await constantTimeEqual(expected, provided));
      viaSecret = authorized;
    }
    if (!authorized) {
      // 密钥通道未通过 → 退回管理员会话鉴权
      const principal = await authenticate(env, request);
      if (!principal?.admin) {
        return error('unauthorized', 'cron 触发需要有效密钥或管理员登录', 401);
      }
      authorized = true;
    }
    // 触发源开关：外部定时服务用 ?source=github|http|selfhost 或 X-Trigger-Source 声明身份，
    // 未声明归为 http（兼容 cron-job.org / 自架 curl cron 等既有配置）。
    // 管理台「立即监控」走管理员会话，属手动触发，不受渠道开关限制。
    if (viaSecret) {
      const source = normalizeSource(
        url.searchParams.get('source') || request.headers.get('X-Trigger-Source'),
      );
      const state = await store.getTriggerState(env);
      if (!state.sources[source]) {
        await noteTriggerDisabled(env, source);
        return json({ monitored: 0, skipped: true, reason: 'source_disabled', source });
      }
      // 复用本次读取结果更新「上次触发时间」，避免 touch 内部二次读库（省 D1 读）
      await store.touchTriggerSource(env, source, Math.floor(Date.now() / 1000), state.seen);
      // 外部触发才是主力方式，却没吃到「透传 monitor state」的优化：这里补上，省 1 subrequest/轮
      const monitorState = await store.getMonitorState(env);
      return runMonitorCycle(env, false, state, source, false, monitorState);
    }
    return runMonitorCycle(env);
  }

  const matched = matchRoute(request.method, pathname);
  if (!matched) {
    // 非 API 路径返回管理台页面（SPA 入口）。
    // 加 ETag + no-cache：命中 304 时省掉整页传输（省出网与 CPU），
    // no-cache 保证每次都回源校验，不会读到旧版本前端。
    if (!pathname.startsWith('/api/')) {
      const etag = await htmlETag();
      if ((request.headers.get('If-None-Match') || '') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-cache' } });
      }
      return new Response(indexHtml, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: etag, 'Cache-Control': 'no-cache' },
      });
    }
    return error('not_found', '接口不存在', 404);
  }
  const ctx: Context = { env, request, params: matched.params };

  // 鉴权
  if (matched.route.scope) {
    const principal = await authenticate(env, request);
    if (!principal) return error('unauthorized', '请登录或提供有效 API Key', 401);
    if (!principal.admin && !principal.scopes.has(matched.route.scope)) {
      return error('forbidden', 'API Key 权限不足', 403);
    }
    // CSRF 双提交校验：仅针对「管理员会话 + 非安全方法」。
    // API Key 走 Authorization 头、浏览器不会自动附带，天然免疫 CSRF，故不校验。
    if (principal.admin && !SAFE_METHODS.has(request.method)) {
      const headerToken = (request.headers.get('X-CDT-CSRF') || '').trim();
      const cookieToken = (/(?:^|;\s*)cdt_csrf=([^;]+)/.exec(request.headers.get('Cookie') || '')?.[1] || '').trim();
      if (!headerToken || !cookieToken || !(await constantTimeEqual(headerToken, cookieToken))) {
        return error('csrf_failed', 'CSRF 校验失败，请刷新页面后重试', 403);
      }
    }
  }
  // 统一异常兜底：handler 抛错时返回可读的 JSON 错误（而非 Cloudflare 默认
  // 纯文本 500，前端无法解析只能显示「操作失败」）
  try {
    return await matched.route.handler(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return error('handler_failed', `${matched.route.method} ${matched.route.pattern} 执行失败：${msg}`, 500);
  }
}

// 下载类接口的失败响应：纯文本 + 首行是 shell 注释。
// 用户习惯把 curl -o 的返回值直接当脚本执行，若错误体是 JSON，
// 会报出「{error:code:unauthorized}: command not found」这种毫无指向的错。
function downloadError(status: number, message: string): Response {
  return new Response(`# 下载失败（HTTP ${status}）：${message}\n`, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-CDT-Download-Error': message,
    },
  });
}

// 下载自建驱动脚本（driver.mjs / install.sh / uninstall.sh），已按用户填写的配置注入。
//
// 鉴权通道（任一通过即可）：
//   1) 管理员会话 / admin API Key —— 浏览器点「下载」按钮（原行为）；
//   2) X-Cron-Secret 头等于 CRON_SECRET —— 服务器 CLI 场景，curl 拿不到会话 cookie。
// 注意：不再接受 ?key= / ?secret= 查询参数鉴权——查询串会被 CF 日志/Logpush 原样留存，
// 等于把密钥写进 URL 到处泄露；脚本内嵌的密钥改由服务端 resolveCronSecret() 回填。
async function selfhostDownload(ctx: Context): Promise<Response> {
  const cronSecret = await store.resolveCronSecret(ctx.env);
  const sp = new URL(ctx.request.url).searchParams;
  const type = sp.get('type');
  const kind = type === 'install' ? 'install' : type === 'uninstall' ? 'uninstall' : 'driver';
  const url = (sp.get('url') || 'https://你的域名/__cron?source=selfhost').trim();
  const interval = parseInt(sp.get('interval') || '300', 10) || 300;

  // 鉴权只认 X-Cron-Secret 头或管理员会话，不再接受 ?key= / ?secret= 查询参数。
  // 原因：查询串会被 Cloudflare Observability / Logpush 的 ClientRequestURI 原样留存，
  // 还会进浏览器历史与 Referer，等于把触发密钥写在 URL 里到处泄露。密钥应始终走请求头。
  const presented = ctx.request.headers.get('X-Cron-Secret') || '';
  const viaSecret = !!cronSecret && !!presented && await constantTimeEqual(cronSecret, presented);
  if (!viaSecret) {
    const principal = await authenticate(ctx.env, ctx.request);
    if (!principal?.admin) {
      // 两种情况差别很大，必须分开说，否则用户只能看到一句没用的「请登录」：
      //  - 站点没配 CRON_SECRET：自建驱动根本不可能工作，得先去配；
      //  - 站点配了但请求没带：补上头即可。
      return downloadError(401, cronSecret
        ? '未通过鉴权。请登录管理台后重新复制下载链接，或在服务器上带上门槛密钥再取：'
          + 'curl -H "X-Cron-Secret: <CRON_SECRET>" -o cdt-driver.mjs "<本链接>"'
        : '未通过鉴权，且本站点尚未配置 CRON_SECRET。自建驱动靠外部密钥触发监控，'
          + '请先执行 wrangler secret put CRON_SECRET 并重新部署，再重试本命令。');
    }
  }

  // 脚本内嵌的密钥直接取服务端已托管/配置的 CRON_SECRET（resolveCronSecret 的返回值），
  // 不再依赖查询参数传入——查询参数传递等于把密钥放进 URL，会进日志与历史。
  // 能走到这里的人（管理员会话 / 持有正确头）本就知道该密钥，直接用服务端值即可。
  const effectiveSecret = cronSecret;
  if (!effectiveSecret && kind !== 'uninstall') {
    return downloadError(400, '未取得触发密钥：请先在 Worker 侧配置 CRON_SECRET（wrangler secret put CRON_SECRET），'
      + '然后回到本页重新生成下载链接。');
  }

  const isInstall = kind === 'install';
  const isUninstall = kind === 'uninstall';
  // 卸载脚本不含任何密钥与站点配置，内容固定
  const body = isUninstall ? uninstallScript()
    : isInstall ? installScript(url, effectiveSecret, interval)
    : driverScript(url, effectiveSecret, interval);
  const filename = isUninstall ? 'cdt-trigger-uninstall.sh'
    : isInstall ? 'cdt-trigger-install.sh' : 'cdt-trigger-driver.mjs';
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

// 触发密钥管理：Cloudflare 的 Worker Secret 只写不可读，托管进 D1（加密）后可查看/修改。
// 查看：默认只返回脱敏值；?reveal=1 才返回明文（管理员主动揭示，写 audit 留痕）。
// 修改：body.value 为空 = 清除托管、鉴权回退 Worker Secret。
async function getCronSecretHandler(ctx: Context): Promise<Response> {
  const secret = await store.resolveCronSecret(ctx.env);
  const stored = await store.hasStoredCronSecret(ctx.env);
  const reveal = new URL(ctx.request.url).searchParams.get('reveal') === '1';
  if (reveal && secret) {
    await store.addLog(ctx.env, 'audit', '管理员查看了触发密钥明文');
    return json({ configured: true, source: stored ? 'managed' : 'worker_secret', value: secret });
  }
  const masked = secret
    ? (secret.length > 8 ? secret.slice(0, 3) + '****' + secret.slice(-3) : '****')
    : '';
  return json({
    configured: !!secret,
    source: stored ? 'managed' : (secret ? 'worker_secret' : 'none'),
    masked,
  });
}

async function setCronSecretHandler(ctx: Context): Promise<Response> {
  const body = await ctx.request.json().catch(() => null) as Record<string, unknown> | null;
  const value = String(body?.value ?? '').trim();
  if (value && value.length < 12) {
    return error('invalid_input', '密钥太短：至少 12 个字符（它是外部触发监控的唯一门槛，太短易被爆破）', 400);
  }
  await store.setCronSecret(ctx.env, value);
  await store.addLog(ctx.env, 'audit', value
    ? '管理员修改了触发密钥（所有已配置渠道需手动同步为新值，旧值会立即 401）'
    : '管理员清除了托管密钥，触发鉴权回退到 Worker Secret（CRON_SECRET）');
  return json({ ok: true });
}

// 触发源开关：读取（管理员）
async function getTriggers(ctx: Context): Promise<Response> {
  const { sources, seen } = await store.getTriggerState(ctx.env);
  return json({
    sources,
    seen,
    labels: TRIGGER_LABELS,
    gapThresholdSeconds: TRIGGER_GAP_THRESHOLD_SEC,
    secretConfigured: (await store.resolveCronSecret(ctx.env)) !== '',
  });
}

// 触发源开关：保存（管理员）
async function saveTriggers(ctx: Context): Promise<Response> {
  const body = await ctx.request.json().catch(() => null) as Record<string, unknown> | null;
  const { sources } = await store.getTriggerState(ctx.env);
  let changed = 0;
  for (const source of TRIGGER_SOURCES) {
    if (body && typeof body[source] === 'boolean') {
      sources[source] = body[source] as boolean;
      changed++;
    }
  }
  if (changed === 0) return error('invalid_input', '未提供任何渠道开关（github / http / selfhost / native / tencent / aliyun / huawei）', 400);
  await store.setTriggerSources(ctx.env, sources);
  const detail = TRIGGER_SOURCES.map((s) => `${TRIGGER_LABELS[s]}=${sources[s] ? '开' : '关'}`).join('、');
  await store.addLog(ctx.env, 'audit', `更新监控触发源开关：${detail}`);
  return json({ ok: true, sources });
}

// 触发源状态查询（密钥或管理员会话）：供外部触发源调用前先查开关，省掉无用触发
async function triggerStatus(ctx: Context): Promise<Response> {
  const env = ctx.env;
  const expected = await store.resolveCronSecret(env);
  let ok = false;
  if (expected) {
    const provided = ctx.request.headers.get('X-Cron-Secret') || '';
    ok = !!provided && (await constantTimeEqual(expected, provided));
  }
  if (!ok) {
    const principal = await authenticate(env, ctx.request);
    ok = !!principal?.admin;
  }
  if (!ok) return error('unauthorized', '需要有效密钥或管理员登录', 401);
  const { sources, seen } = await store.getTriggerState(env);
  return json({ sources, seen });
}

// 测试某个渠道：以该渠道身份真实跑一轮监控（绕过防抖），验证链路是否可用。
// 外部渠道（github / selfhost / http）无法由 Worker 主动验证"对方服务是否在跑"，
// 只能验证「Worker 侧能否接受该渠道 + 密钥 + 跑一轮」，外部侧看「上次触发时间」。
async function testTrigger(ctx: Context): Promise<Response> {
  const body = await ctx.request.json().catch(() => null) as Record<string, unknown> | null;
  const source = normalizeSource(String(body?.source ?? ''));
  const { sources, seen } = await store.getTriggerState(ctx.env);
  const secretConfigured = (await store.resolveCronSecret(ctx.env)) !== '';
  if (!sources[source]) {
    return json({
      ok: false, source, enabled: false, secretConfigured,
      lastSeen: seen[source] ?? 0,
      message: `渠道「${TRIGGER_LABELS[source]}」当前是关闭状态，Worker 会忽略它的触发；如需启用请先打开开关。`,
    });
  }
  const nowSec = Math.floor(Date.now() / 1000);
  // 限流：每个渠道每分钟最多测一次。测试会 force 跑整轮监控（阿里云 API + 通知投递），
  // 放任连点等于把外部 API 与通知通道打爆。
  const minuteKey = `trigger_test:${source}:${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  if (!(await store.recordActionEvent(ctx.env, minuteKey, 0, 'trigger_test', 'attempting', ''))) {
    return json({
      ok: false, source, throttled: true,
      message: `渠道「${TRIGGER_LABELS[source]}」刚测试过，请 1 分钟后再试（测试会真实跑一轮监控，需限流）。`,
    });
  }
  await store.touchTriggerSource(ctx.env, source, nowSec, seen);
  const resp = await runMonitorCycle(ctx.env, true, undefined, source, true);
  const data = await resp.clone().json().catch(() => ({})) as Record<string, unknown>;
  // 原生 Cron 的说明：CF 固定每 5 分钟调度一次，实际频率由「监控间隔」决定；
  // 手动测试这一轮是强制执行的，不必等下一个周期。
  const ms = await store.getMonitorState(ctx.env);
  const extra = source === 'native'
    ? ` 原生 Cron 由 Cloudflare 每 5 分钟调度一次，实际频率以「监控间隔」（${ms.intervalMinutes} 分钟）为准；本轮为手动强制执行，无需等待下一周期。`
    : (secretConfigured ? '' : ' ⚠️ 未配置 CRON_SECRET，外部匿名触发会被 401 拒绝。');
  return json({
    ok: true, source, enabled: true, secretConfigured,
    lastSeen: nowSec, simulated: true,
    monitored: data.monitored ?? 0,
    message: `已以「${TRIGGER_LABELS[source]}」身份真实触发一轮监控（已跳过防抖）。`
      + extra,
  });
}

// 渠道被关闭时的留痕（每个渠道每小时至多一条，避免刷屏）
export async function noteTriggerDisabled(env: Env, source: TriggerSource): Promise<void> {
  const hour = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const key = `trigger_disabled:${source}:${hour}`;
  if (await store.recordActionEvent(env, key, 0, 'trigger', 'skipped', '')) {
    await store.addLog(env, 'info', `触发源「${TRIGGER_LABELS[source]}」已关闭，本次触发已跳过`);
  }
}

// 断档告警：已启用的渠道超过阈值（默认 30 分钟）没触发 → 每渠道每小时至多一条 warning。
// 场景：GitHub Actions 的 schedule 被自动禁用/延迟、自建驱动挂了、cron-job.org 停摆等。
async function checkTriggerGaps(
  env: Env,
  sources: Record<TriggerSource, boolean>,
  seen: Partial<Record<TriggerSource, number>>,
): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const hour = new Date().toISOString().slice(0, 13);
  for (const source of TRIGGER_SOURCES) {
    if (!isSourceStale(sources[source], seen[source], nowSec)) continue;
    const key = `trigger_gap:${source}:${hour}`;
    if (!(await store.recordActionEvent(env, key, 0, 'trigger', 'stale', ''))) continue;
    const minutes = Math.floor((nowSec - (seen[source] ?? nowSec)) / 60);
    await store.addLog(env, 'warning',
      `触发源「${TRIGGER_LABELS[source]}」已断档 ${minutes} 分钟没有触发，请检查该渠道是否正常（否则会错过开关机窗口）`);
  }
}

// 执行一轮监控（供 fetch 的 /__cron 与 scheduled 入口共用，都走同一套防抖与抢占）
// source：本轮的触发渠道（原生 Cron / 外部渠道 / 测试按钮）；未传表示管理台「立即监控」的手动触发。
// isTest：是否来自「测试渠道」按钮，仅用于在日志里区分，不影响并发与幂等逻辑。
export async function runMonitorCycle(
  env: Env,
  force = false,
  triggerState?: { sources: Record<TriggerSource, boolean>; seen: Partial<Record<TriggerSource, number>> },
  source?: TriggerSource,
  isTest = false,
  preloadedMonitorState?: { intervalMinutes: number; lastRun: number },
): Promise<Response> {
  // 防抖前置：先做轻量判断（单条 settings 查询），命中跳过则直接返回，
  // 不再全量 getConfig（读全量 settings + 解密所有账号 AK/SK），省 CPU 与 D1 读。
  // force=true 用于前台「测试渠道」按钮：绕过防抖真实跑一轮，验证链路是否可用。
  // 原生 Cron 入口（index.ts scheduled）已经读过一次 monitor state，透传进来省掉重复查询（省 1 subrequest/轮）。
  const state = preloadedMonitorState ?? await store.getMonitorState(env);
  const debounceSeconds = Math.max(0, state.intervalMinutes * 60 - 45);
  const nowSec = Math.floor(Date.now() / 1000);
  const sinceLastRun = state.lastRun > 0 ? nowSec - state.lastRun : Infinity;
  if (!force && sinceLastRun < debounceSeconds) {
    return json({ monitored: 0, skipped: true, next_in_seconds: debounceSeconds - sinceLastRun });
  }

  // 断档告警门控：只在「整点 / 半点」检查。
  // 断档阈值本身是 30 分钟量级，半点扫一次即可；否则每轮都要 1 次 getTriggerState + 最多 6 次
  // 探键（288 轮/天 ≈ 1728 次 D1 读），而其中绝大多数是被防抖跳过的空转请求。
  if (new Date().getUTCMinutes() % 30 === 0) {
    const gapState = triggerState ?? await store.getTriggerState(env);
    await checkTriggerGaps(env, gapState.sources, gapState.seen);
  }
  // 原子抢占监控槽位：并发触发（外部服务 + 原生 Cron + 前台按钮同时打过来）时
  // 只有一个能把 last_monitor_run 写成当前时间，其余在此返回 skipped。
  if (!(await store.tryAcquireMonitorSlot(env, force ? 0 : debounceSeconds))) {
    return json({ monitored: 0, skipped: true, next_in_seconds: 0 });
  }
  const config = await store.getConfig(env);
  const started = Date.now();
  // 账号并行处理（并发上限 3）：Free 计划同时出站连接上限是 6，每账号并发 2 个阿里云 fetch，
  // 5 个账号同轮并发会开到 10 个连接、超出上限触发 1101/超时；降到 3 后峰值 6 个连接，贴合上限。
  const results: Awaited<ReturnType<typeof engine.processAccount>>[] = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < config.accounts.length; i += CONCURRENCY) {
    const batch = config.accounts.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((a) => engine.processAccount(env, a, false, config)));
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      if (s.status === 'fulfilled') results.push(s.value);
      // accessKeyId 是完整 AK，不能进日志；有 remark 时优先用备注，否则只记脱敏后的 AK
      else await store.addLog(env, 'error', `监控账号失败 [${batch[j].remark || masked(batch[j].accessKeyId)}]: ${s.reason}`);
    }
  }
  // 槽位已在进入时原子抢占（tryAcquireMonitorSlot），无需再写 last_monitor_run
  // 消费通知队列（失败自动重试，不影响监控主流程）
  try {
    await engine.flushOutbox(env, config);
  } catch (err) {
    await store.addLog(env, 'error', `通知队列处理异常: ${err}`);
  }
  // 过期数据清理（日志 + traffic_stats/action_events/login_attempts/sessions）。
  // 改为「每天一次」：这些是维护性操作，没必要每个监控周期都跑（省 D1 查询与写）。
  try {
    const dayKey = `cleanup:${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    if (await store.recordActionEvent(env, dayKey, 0, 'maintenance', 'cleanup', '')) {
      await store.cleanupExpiredLogs(env, config.logRetentionDays);
      await store.cleanupExpiredData(env, config.logRetentionDays);
    }
  } catch { /* 清理失败不影响监控主流程 */ }
  // 记录本次监控周期到日志，让前台「日志页」能确认定时触发确实在运行。
  // 账号级 heartbeat 只在「有动作 / 状态变化」时写，这里补一条周期级汇总，
  // 这样日志页既能看到"每轮都在跑"，又不会灌进 5 账号 × 288 轮的重复噪声。
  // 带上触发渠道：日志页要能看出「这轮是谁叫起来的」（原生 Cron / 外部渠道 / 手动），
  // 否则多渠道并行时排查只能靠猜。渠道名取自 TRIGGER_LABELS，未传即管理台手动触发。
  const elapsed = Date.now() - started;
  const refreshed = results.filter((r) => r && r.refreshed).length;
  const changed = results.filter((r) => r && r.statusChanged).length;
  const origin = source ? TRIGGER_LABELS[source] + (isTest ? ' · 测试' : '') : '手动触发';
  if (results.length > 0) {
    await store.addLog(env, 'info',
      `监控周期完成 [${origin}]：处理 ${results.length} 个账号（${refreshed} 个刷新数据，${changed} 个状态有变化，耗时 ${elapsed} ms）`);
  } else {
    await store.addLog(env, 'info', `监控周期已触发 [${origin}]，但尚未配置任何账号（请到「账号」页添加）`);
  }

  // DDNS 轮换解析同步：搭监控周期的便车执行，不再单独占一个 Cron 槽位与触发次数。
  // 内部幂等是省额度的关键——目标 IP 与厂商当前值一致时不调厂商 API，
  // 按天轮换的分组一天最多真正写一次，window 模式也只会在跨时段时写。
  // 整段包 try/catch：DDNS 出错绝不能影响监控主流程的返回值与上面的周期日志。
  try {
    const ddns = await runDdnsSync(env);
    // 只在「有切换或有失败」时写汇总，避免每 5 分钟一条无意义日志灌满日志页
    if (ddns.changed > 0 || ddns.failed > 0) {
      await store.addLog(env, ddns.failed > 0 ? 'warning' : 'info',
        `DDNS 轮换同步：${ddns.groups} 个分组 / ${ddns.records} 条记录，切换 ${ddns.changed} 条，失败 ${ddns.failed} 条`);
    }
  } catch (err) {
    await store.addLog(env, 'error', `DDNS 轮换同步异常: ${err}`);
  }

  return json({ monitored: results.length, interval_minutes: config.monitorInterval, source: source ?? 'manual' });
}

/* ------------------------------ DDNS 轮换解析 API ------------------------------ */

// 统一取 body：非法 JSON 当空对象处理，避免每个 handler 各写一遍 catch
async function ddnsBody(ctx: Context): Promise<Record<string, any>> {
  const b = await ctx.request.json().catch(() => null);
  return (b && typeof b === 'object' ? b : {}) as Record<string, any>;
}

function ddnsId(ctx: Context): number {
  const id = Number(ctx.params.id);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

/**
 * 总览：机器 + 分组（含成员/记录）+ 厂商元信息，一次取全。
 * 前端每开一次页面只发这一个请求，省掉「先拉分组再逐组拉记录」的多次往返。
 * 凭据只回脱敏值，密文与明文都不出后端。
 */
async function ddnsOverview(ctx: Context): Promise<Response> {
  const machines = await ddnsStore.listMachines(ctx.env);
  const groups = await ddnsStore.listGroups(ctx.env);
  const outGroups = [];
  for (const g of groups) {
    const records = [];
    for (const r of g.records) {
      const cred = await ddnsStore.readCredential(ctx.env, r);
      records.push({
        ...r,
        credential_enc: '', // 密文不外传：前端拿不到也就无法误泄露
        credentialMasked: ddnsStore.maskCredential(cred),
        credentialFilled: Object.keys(cred).length > 0,
      });
    }
    outGroups.push({ ...g, records });
  }
  return json({ machines, groups: outGroups, providers: listProviders() });
}

/* ---- 机器 ---- */

async function ddnsCreateMachine(ctx: Context): Promise<Response> {
  const b = await ddnsBody(ctx);
  const name = String(b.name ?? '').trim();
  const ip = String(b.ip ?? '').trim();
  if (!name) return error('invalid_input', '机器名称不能为空', 400);
  if (!ip) return error('invalid_input', '机器 IP 不能为空', 400);
  // 只做形状校验（IPv4 点分十进制），不做可达性探测——那是监控循环的活
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return error('invalid_input', 'IP 格式不正确，请填写 IPv4 地址', 400);
  const id = await ddnsStore.createMachine(ctx.env, name, ip, String(b.remark ?? '').trim(), b.enabled !== false);
  await store.addLog(ctx.env, 'audit', `新增 DDNS 机器「${name}」（${ip}）`);
  return json({ ok: true, id }, 201);
}

async function ddnsUpdateMachine(ctx: Context): Promise<Response> {
  const id = ddnsId(ctx);
  if (!id) return error('invalid_input', '机器 ID 无效', 400);
  const b = await ddnsBody(ctx);
  const name = String(b.name ?? '').trim();
  const ip = String(b.ip ?? '').trim();
  if (!name) return error('invalid_input', '机器名称不能为空', 400);
  if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return error('invalid_input', 'IP 格式不正确，请填写 IPv4 地址', 400);
  await ddnsStore.updateMachine(ctx.env, id, name, ip, String(b.remark ?? '').trim(), b.enabled !== false);
  return json({ ok: true });
}

async function ddnsDeleteMachine(ctx: Context): Promise<Response> {
  const id = ddnsId(ctx);
  if (!id) return error('invalid_input', '机器 ID 无效', 400);
  await ddnsStore.deleteMachine(ctx.env, id);
  await store.addLog(ctx.env, 'audit', `删除 DDNS 机器 #${id}（各分组的成员关系同步移除）`);
  return json({ ok: true });
}

/* ---- 分组 ---- */

function parseGroupBody(b: Record<string, any>) {
  return {
    name: String(b.name ?? '').trim(),
    mode: String(b.mode ?? 'rotate').trim(),
    timezone: String(b.timezone ?? 'Asia/Shanghai').trim() || 'Asia/Shanghai',
    switchTime: String(b.switchTime ?? '03:00').trim() || '03:00',
    anchorDate: String(b.anchorDate ?? '1970-01-01').trim() || '1970-01-01',
    fallbackIp: String(b.fallbackIp ?? '').trim(),
    enabled: b.enabled !== false,
  };
}

async function ddnsCreateGroup(ctx: Context): Promise<Response> {
  const b = await ddnsBody(ctx);
  const g = parseGroupBody(b);
  if (!g.name) return error('invalid_input', '分组名称不能为空', 400);
  if (!['rotate', 'window', 'static'].includes(g.mode)) return error('invalid_input', '排班模式只能是 rotate / window / static', 400);
  const id = await ddnsStore.createGroup(ctx.env, g);
  await store.addLog(ctx.env, 'audit', `新增 DDNS 分组「${g.name}」（模式 ${g.mode}）`);
  return json({ ok: true, id }, 201);
}

async function ddnsUpdateGroup(ctx: Context): Promise<Response> {
  const id = ddnsId(ctx);
  if (!id) return error('invalid_input', '分组 ID 无效', 400);
  const b = await ddnsBody(ctx);
  const g = parseGroupBody(b);
  if (!g.name) return error('invalid_input', '分组名称不能为空', 400);
  if (!['rotate', 'window', 'static'].includes(g.mode)) return error('invalid_input', '排班模式只能是 rotate / window / static', 400);
  await ddnsStore.updateGroup(ctx.env, id, g);
  return json({ ok: true });
}

async function ddnsDeleteGroup(ctx: Context): Promise<Response> {
  const id = ddnsId(ctx);
  if (!id) return error('invalid_input', '分组 ID 无效', 400);
  await ddnsStore.deleteGroup(ctx.env, id);
  await store.addLog(ctx.env, 'audit', `删除 DDNS 分组 #${id}（成员与解析记录同步移除）`);
  return json({ ok: true });
}

/** 全量保存组内成员与排班参数（前端拖拽排序后整体提交） */
async function ddnsSaveMembers(ctx: Context): Promise<Response> {
  const id = ddnsId(ctx);
  if (!id) return error('invalid_input', '分组 ID 无效', 400);
  const b = await ddnsBody(ctx);
  const raw = Array.isArray(b.members) ? b.members : null;
  if (!raw) return error('invalid_input', 'members 必须是数组', 400);
  const members = raw.map((m: any, i: number) => ({
    machineId: Number(m?.machineId),
    days: Math.max(1, Math.floor(Number(m?.days) || 1)),
    windowStart: String(m?.windowStart ?? '').trim(),
    windowEnd: String(m?.windowEnd ?? '').trim(),
    sortOrder: Number.isFinite(Number(m?.sortOrder)) ? Number(m.sortOrder) : i,
  })).filter((m: { machineId: number }) => Number.isFinite(m.machineId) && m.machineId > 0);
  await ddnsStore.saveMembers(ctx.env, id, members);
  return json({ ok: true, count: members.length });
}

/* ---- 解析记录 ---- */

async function ddnsCreateRecord(ctx: Context): Promise<Response> {
  const b = await ddnsBody(ctx);
  const groupId = Number(b.groupId);
  const provider = String(b.provider ?? '').trim();
  const zone = String(b.zone ?? '').trim();
  if (!groupId) return error('invalid_input', '所属分组不能为空', 400);
  if (!listProviders().some((p) => p.id === provider)) return error('invalid_input', `不支持的 DNS 厂商：${provider}`, 400);
  if (!zone) return error('invalid_input', '域名（zone）不能为空', 400);
  const id = await ddnsStore.createRecord(ctx.env, {
    groupId,
    provider,
    zone,
    host: String(b.host ?? '@').trim() || '@',
    ttl: Math.max(60, Math.floor(Number(b.ttl) || 600)),
    credential: (b.credential && typeof b.credential === 'object') ? b.credential as Record<string, string> : {},
    enabled: b.enabled !== false,
  });
  await store.addLog(ctx.env, 'audit', `新增 DDNS 解析记录 ${zone}（厂商 ${provider}）`);
  return json({ ok: true, id }, 201);
}

async function ddnsUpdateRecord(ctx: Context): Promise<Response> {
  const id = ddnsId(ctx);
  if (!id) return error('invalid_input', '记录 ID 无效', 400);
  const b = await ddnsBody(ctx);
  const patch: Parameters<typeof ddnsStore.updateRecord>[2] = {};
  if (b.provider !== undefined) {
    const provider = String(b.provider).trim();
    if (!listProviders().some((p) => p.id === provider)) return error('invalid_input', `不支持的 DNS 厂商：${provider}`, 400);
    patch.provider = provider;
  }
  if (b.zone !== undefined) {
    const zone = String(b.zone).trim();
    if (!zone) return error('invalid_input', '域名（zone）不能为空', 400);
    patch.zone = zone;
  }
  if (b.host !== undefined) patch.host = String(b.host).trim() || '@';
  if (b.ttl !== undefined) patch.ttl = Math.max(60, Math.floor(Number(b.ttl) || 600));
  if (b.enabled !== undefined) patch.enabled = !!b.enabled;
  // 凭据只在显式传来对象时才覆盖：前端「只改 TTL」时不该把密钥清空
  if (b.credential !== undefined && b.credential && typeof b.credential === 'object') {
    const cred = b.credential as Record<string, string>;
    // 前端会把未修改的脱敏值（含 ****）回传，这里剔除掉，避免把掩码写进库里
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(cred)) {
      const s = String(v ?? '').trim();
      if (s && !s.includes('****')) clean[k] = s;
    }
    if (Object.keys(clean).length > 0) patch.credential = clean;
  }
  await ddnsStore.updateRecord(ctx.env, id, patch);
  return json({ ok: true });
}

async function ddnsDeleteRecord(ctx: Context): Promise<Response> {
  const id = ddnsId(ctx);
  if (!id) return error('invalid_input', '记录 ID 无效', 400);
  await ddnsStore.deleteRecord(ctx.env, id);
  return json({ ok: true });
}

/* ---- 同步 / 预览 ---- */

/** 手动同步：force 为真时忽略本地记录、强制查一次厂商 */
async function ddnsSyncHandler(ctx: Context): Promise<Response> {
  const b = await ddnsBody(ctx);
  const groupId = b.groupId ? Number(b.groupId) : undefined;
  const out = await runDdnsSync(ctx.env, {
    force: b.force === true,
    groupId: Number.isFinite(groupId) && groupId ? groupId : undefined,
    manual: true,
  });
  await store.addLog(ctx.env, out.failed > 0 ? 'warning' : 'info',
    `手动触发 DDNS 同步：切换 ${out.changed} 条，失败 ${out.failed} 条，跳过 ${out.skipped} 条`);
  // 明细直接回前端：用户点「立即同步」就是为了看到结果，再看日志页成本高
  return json({ ok: out.failed === 0, ...out });
}

/** 预览未来排班：rotate 模式按天输出，window/static 只返回当前命中 */
async function ddnsPreviewHandler(ctx: Context): Promise<Response> {
  const sp = new URL(ctx.request.url).searchParams;
  const groupId = Number(sp.get('group_id'));
  if (!Number.isFinite(groupId) || groupId <= 0) return error('invalid_input', '缺少有效的 group_id', 400);
  const days = Math.min(30, Math.max(1, Math.floor(Number(sp.get('days')) || 7)));
  const rows = await previewGroups(ctx.env, groupId, days);
  if (!rows) return error('not_found', '分组不存在', 404);
  return json({ rows });
}
