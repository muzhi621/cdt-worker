// HTTP 层：路由 + 鉴权 + API
// 对应原 Go 项目 internal/httpapi/server.go
// 使用原生 fetch handler（Worker 环境），不引入第三方框架

import * as store from '../store/store';
import * as engine from '../engine/engine';
import { hashPassword, verifyPassword, constantTimeEqual, envPassword, newToken, tokenHash, type Env } from '../security/security';
import { deliverEvent } from '../notify/service';
import type { Account } from '../provider/aliyun';
import indexHtml from '../web/index.html';

type Context = { env: Env; request: Request; params: Record<string, string> };

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
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// 简单内存限流（单 Isolate 内有效）
const rateMap = new Map<string, { start: number; count: number }>();
function allowRate(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
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
      'SELECT scopes, expires_at, revoked_at FROM api_keys WHERE token_hash = ?',
    ).bind(hash).first();
    if (!row) return null;
    const r = row as Record<string, unknown>;
    if (r.revoked_at) return null;
    if (r.expires_at && new Date(String(r.expires_at)).getTime() < Date.now()) return null;
    let scopes: string[] = [];
    try { scopes = JSON.parse(String(r.scopes)); } catch { /* empty */ }
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
  { method: 'GET', pattern: '/api/v1/system/init-status', handler: async (ctx) => json({
      initialized: await store.isInitialized(ctx.env),
      // 已通过 Cloudflare 环境变量配置恢复密码（未初始化时也可直接用它登录）
      envPasswordSet: envPassword(ctx.env) !== '',
    }) },
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

async function login(ctx: Context): Promise<Response> {
  const ip = clientIP(ctx.request);
  if (!allowRate('login:' + ip, 8, 15 * 60_000)) {
    return error('rate_limited', '登录尝试过多，请稍后再试', 429);
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
    return error('invalid_credentials', '密码错误', 401);
  }

  // 用环境变量密码登录成功：回写 D1 哈希，使密码与会话状态一致
  if (viaEnvPassword) {
    if (password.length >= 10) {
      await store.setPasswordHash(ctx.env, await hashPassword(password));
      await store.addLog(ctx.env, 'audit', '使用环境变量 ADMIN_PASSWORD 登录成功，管理员密码已同步为该值 [IP: ' + ip + ']');
    } else {
      await store.addLog(ctx.env, 'audit', '使用环境变量 ADMIN_PASSWORD 登录成功（密码长度不足 10 位，未同步到 D1）[IP: ' + ip + ']');
    }
  }

  const { token, csrf } = await createSession(ctx.env, ctx.request);
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
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearAuthCookies() },
  });
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

function clearAuthCookies(): string {
  return 'cdt_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict, cdt_csrf=; Path=/; Max-Age=0; SameSite=Strict';
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
    logRetentionDays: config.logRetentionDays,
    notifications: {
      telegram: { ...n.telegram, token: '', tokenConfigured: !!n.telegram.token },
      webhook: { ...n.webhook, secret: '', secretConfigured: !!n.webhook.secret },
      serverchan: { ...n.serverchan, sendKey: '', sendKeyConfigured: !!n.serverchan.sendKey },
      pushplus: { ...n.pushplus, token: '', tokenConfigured: !!n.pushplus.token },
      smtp: { ...n.smtp, password: '', passwordConfigured: !!n.smtp.password },
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
  return next;
}

async function saveConfig(ctx: Context): Promise<Response> {
  const body = await ctx.request.json().catch(() => null);
  if (!body || typeof body !== 'object') return error('invalid_request', 'invalid JSON', 400);
  const b = body as Record<string, unknown>;
  // 仅写入请求中显式传入的设置项：添加账号只传 accounts 时不会重置其他参数
  const optionalSettings: [string, unknown, string][] = [
    ['traffic_threshold', b.trafficThreshold, String(b.trafficThreshold ?? 95)],
    ['shutdown_mode', b.shutdownMode, String(b.shutdownMode ?? 'KeepCharging')],
    ['threshold_action', b.thresholdAction, String(b.thresholdAction ?? 'stop_and_notify')],
    ['api_interval', b.apiInterval, String(b.apiInterval ?? 600)],
    ['monitor_interval', b.monitorInterval, String(b.monitorInterval ?? 5)],
    ['timezone', b.timezone, String(b.timezone ?? 'Asia/Shanghai')],
    ['keep_alive', b.keepAlive, b.keepAlive ? '1' : '0'],
    ['enable_billing', b.enableBilling, b.enableBilling ? '1' : '0'],
    ['enable_schedule_mail', b.enableScheduleMail, b.enableScheduleMail ? '1' : '0'],
  ];
  const settings: [string, string][] = [];
  for (const [key, present, value] of optionalSettings) {
    if (present !== undefined) settings.push([key, value]);
  }
  // logRetentionDays 仅在显式传入时才写入，避免设置页保存时误重置
  if (b.logRetentionDays !== undefined) {
    settings.push(['log_retention_days', String(b.logRetentionDays ?? 30)]);
  }
  for (const [k, v] of settings) {
    await ctx.env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').bind(k, v).run();
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
    await ctx.env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').bind('notifications', JSON.stringify(merged)).run();
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
  const result = await engine.processAccount(ctx.env, account, true);
  return json({ job: result }, 202);
}

async function controlHandler(ctx: Context): Promise<Response> {
  const id = parseInt(ctx.params.id, 10);
  const action = ctx.params.action as 'start' | 'stop';
  if (action !== 'start' && action !== 'stop') return error('invalid_action', 'action must be start or stop', 400);
  const message = await engine.control(ctx.env, id, action, '手动');
  return json({ success: true, message }, 202);
}

async function logsHandler(ctx: Context): Promise<Response> {
  const url = new URL(ctx.request.url);
  const category = url.searchParams.get('category') || 'all';
  const page = parseInt(url.searchParams.get('page') || '1', 10) || 1;
  const pageSize = parseInt(url.searchParams.get('pageSize') || '50', 10) || 50;
  const data = await store.listLogs(ctx.env, category, page, pageSize);
  // D1 的 created_at 是 UTC（datetime('now')），按配置时区转换为本地时间字符串展示
  let tz = 'Asia/Shanghai';
  try {
    const cfg = await store.getConfig(ctx.env);
    tz = cfg.timezone || tz;
  } catch { /* 读配置失败用默认时区 */ }
  const logs = data.logs.map((l) => ({ ...l, created_at: toZoneString(l.created_at, tz) }));
  return json({ ...data, logs, timezone: tz });
}

// 把 "YYYY-MM-DD HH:mm:ss"（UTC）转为指定时区的同格式字符串
function toZoneString(utc: string, timezone: string): string {
  if (!utc) return utc;
  const ms = Date.parse(utc.replace(' ', 'T') + 'Z');
  if (isNaN(ms)) return utc;
  try {
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone: timezone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(ms));
    return parts; // sv-SE 恰好是 YYYY-MM-DD HH:mm:ss
  } catch {
    return utc;
  }
}

async function clearLogsHandler(ctx: Context): Promise<Response> {
  const category = new URL(ctx.request.url).searchParams.get('category') || 'all';
  await store.clearLogs(ctx.env, category);
  return json({ success: true });
}

// 测试通知：向所有已启用通道发送一条测试消息
async function notifyTestHandler(ctx: Context): Promise<Response> {
  const config = await store.getConfig(ctx.env);
  let channel = '';
  try {
    const body = await ctx.request.json().catch(() => null);
    channel = String((body as Record<string, unknown>)?.channel ?? '').trim();
  } catch { /* 无 body 则测全部 */ }
  const validChannels = ['telegram', 'webhook', 'serverchan', 'pushplus', 'smtp'];
  if (channel && validChannels.indexOf(channel) < 0) return error('invalid_channel', '未知的通知通道', 400);
  // 测试事件带上账号变量示例（取第一个账号），便于预览自定义模板渲染效果
  const sample = config.accounts[0];
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
  const id = parseInt(ctx.params.id, 10);
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
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(q);
      else if (p !== q) { match = false; break; }
    }
    if (match) return { route, params };
  }
  return null;
}

export async function handleRequest(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Cron 触发器（监控循环）
  if (request.headers.get('X-Cron-Trigger') === 'true' || url.pathname === '/__cron') {
    return runMonitorCycle(env);
  }

  const matched = matchRoute(request.method, pathname);
  if (!matched) {
    // 非 API 路径返回管理台页面（SPA 入口）
    if (!pathname.startsWith('/api/')) {
      return new Response(indexHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
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
  }
  return matched.route.handler(ctx);
}

async function runMonitorCycle(env: Env): Promise<Response> {
  const config = await store.getConfig(env);
  // 防抖：距上次监控不足配置间隔则跳过（避免外部 cron 频繁触发重复执行）
  if (!(await store.shouldRunMonitor(env, config.monitorInterval))) {
    return json({ monitored: 0, skipped: true, next_in_seconds: config.monitorInterval * 60 });
  }
  const started = Date.now();
  // 账号并行处理（并发上限 5）：串行时 5 个账号需 18s+，易触发外部触发的 curl 超时
  const results: Awaited<ReturnType<typeof engine.processAccount>>[] = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < config.accounts.length; i += CONCURRENCY) {
    const batch = config.accounts.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((a) => engine.processAccount(env, a, false, config)));
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      if (s.status === 'fulfilled') results.push(s.value);
      else await store.addLog(env, 'error', `监控账号失败 [${batch[j].remark || batch[j].accessKeyId}]: ${s.reason}`);
    }
  }
  await store.markMonitorRun(env);
  // 消费通知队列（失败自动重试，不影响监控主流程）
  try {
    await engine.flushOutbox(env, config);
  } catch (err) {
    await store.addLog(env, 'error', `通知队列处理异常: ${err}`);
  }
  // 顺带清理超期日志（幂等、低成本，避免日志无限增长）
  try {
    await store.cleanupExpiredLogs(env, config.logRetentionDays);
  } catch { /* 清理失败不影响监控主流程 */ }
  // 记录本次监控周期到日志，让前台「日志页」能确认定时触发确实在运行
  const elapsed = Date.now() - started;
  if (results.length > 0) {
    await store.addLog(env, 'info', `监控周期完成，本次处理 ${results.length} 个账号（耗时 ${elapsed} ms）`);
  } else {
    await store.addLog(env, 'info', '监控周期已触发，但尚未配置任何账号（请到「账号」页添加）');
  }
  return json({ monitored: results.length, interval_minutes: config.monitorInterval });
}
