// HTTP 层：路由 + 鉴权 + API
// 对应原 Go 项目 internal/httpapi/server.go
// 使用原生 fetch handler（Worker 环境），不引入第三方框架

import * as store from '../store/store';
import * as engine from '../engine/engine';
import { hashPassword, verifyPassword, newToken, tokenHash, type Env } from '../security/security';
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
  { method: 'GET', pattern: '/api/v1/system/init-status', handler: async (ctx) => json({ initialized: await store.isInitialized(ctx.env) }) },
  { method: 'POST', pattern: '/api/v1/setup', handler: setup },
  { method: 'POST', pattern: '/api/v1/auth/login', handler: login },
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
  await ctx.env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').bind('admin_password_hash', hash).run();
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
  const hashRow = await ctx.env.DB.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").first();
  const storedHash = String((hashRow as Record<string, unknown>)?.value ?? '');
  const valid = storedHash && await verifyPassword(storedHash, password);
  if (!valid) {
    await ctx.env.DB.prepare('INSERT INTO login_attempts (ip) VALUES (?)').bind(ip).run();
    await store.addLog(ctx.env, 'warning', '管理员登录失败 [IP: ' + ip + ']');
    return error('invalid_credentials', '密码错误', 401);
  }
  const { token, csrf } = await createSession(ctx.env, ctx.request);
  await store.addLog(ctx.env, 'audit', '管理员登录成功 [IP: ' + ip + ']');
  return setAuthCookies(json({ success: true, csrf_token: csrf }, 200), token, csrf, ctx.request);
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
  // 脱敏：不返回密码哈希和已加密的 secret 明文
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
    notifications: config.notifications,
    accounts: config.accounts.map((a) => ({ ...a, accessKeyId: '', accessKeySecret: '' })),
  };
  return json(safe);
}

async function saveConfig(ctx: Context): Promise<Response> {
  const body = await ctx.request.json().catch(() => null);
  if (!body || typeof body !== 'object') return error('invalid_request', 'invalid JSON', 400);
  const b = body as Record<string, unknown>;
  // 保存设置项
  const settings: [string, string][] = [
    ['traffic_threshold', String(b.trafficThreshold ?? 95)],
    ['shutdown_mode', String(b.shutdownMode ?? 'KeepCharging')],
    ['threshold_action', String(b.thresholdAction ?? 'stop_and_notify')],
    ['api_interval', String(b.apiInterval ?? 600)],
    ['monitor_interval', String(b.monitorInterval ?? 5)],
    ['timezone', String(b.timezone ?? 'Asia/Shanghai')],
    ['keep_alive', b.keepAlive ? '1' : '0'],
    ['enable_billing', b.enableBilling ? '1' : '0'],
    ['enable_schedule_mail', b.enableScheduleMail ? '1' : '0'],
  ];
  for (const [k, v] of settings) {
    await ctx.env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').bind(k, v).run();
  }
  if (b.notifications) {
    await ctx.env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').bind('notifications', JSON.stringify(b.notifications)).run();
  }
  // 保存账号（带明文 secret 时更新，否则跳过）
  if (Array.isArray(b.accounts)) {
    for (const a of b.accounts as Partial<Account>[]) {
      if (a.accessKeySecret) {
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
  const tab = new URL(ctx.request.url).searchParams.get('tab') || '';
  return json({ logs: await store.listLogs(ctx.env, tab, 100) });
}

async function clearLogsHandler(ctx: Context): Promise<Response> {
  const tab = new URL(ctx.request.url).searchParams.get('tab') || '';
  await store.clearLogs(ctx.env, tab);
  return json({ success: true });
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
  const results = [];
  for (const account of config.accounts) {
    try {
      results.push(await engine.processAccount(env, account));
    } catch (err) {
      await store.addLog(env, 'error', `监控账号失败: ${err}`);
    }
  }
  await store.markMonitorRun(env);
  return json({ monitored: results.length, interval_minutes: config.monitorInterval });
}
