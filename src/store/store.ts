// 数据访问层：D1 绑定，对应原 Go 项目 internal/store/
// 所有账号凭据字段在存取时做 AES-GCM 加密/解密

import { encrypt, decrypt, type Env } from '../security/security';
import type { Account } from '../provider/aliyun';

export interface Config {
  adminPasswordHash: string;
  trafficThreshold: number;
  shutdownMode: string;
  thresholdAction: string; // stop_and_notify / notify_only
  apiInterval: number;
  monitorInterval: number; // 监控间隔（分钟），外部触发时用于防抖
  timezone: string;
  keepAlive: boolean;
  enableBilling: boolean;
  enableScheduleMail: boolean;
  logRetentionDays: number; // 日志保留天数，超期自动清理
  notifications: {
    telegram: { enabled: boolean; token: string; chatId: string; proxyType: string; proxyUrl: string };
    webhook: { enabled: boolean; url: string; method: string; type: string; provider: string; headers: string; secret: string; body: string };
    serverchan: { enabled: boolean; sendKey: string };
    pushplus: { enabled: boolean; token: string };
    smtp: { enabled: boolean; host: string; port: number; username: string; password: string; from: string; to: string };
    // 自定义通知内容模板（{{变量}} 占位符），留空用默认格式
    template: { body: string };
  };
  accounts: Account[];
}

const DEFAULT_CONFIG: Config = {
  adminPasswordHash: '',
  trafficThreshold: 90,
  shutdownMode: 'StopCharging',
  thresholdAction: 'stop_and_notify',
  apiInterval: 600,
  monitorInterval: 5,
  timezone: 'Asia/Shanghai',
  keepAlive: true,
  enableBilling: true,
  enableScheduleMail: false,
  logRetentionDays: 30,
  notifications: {
    telegram: { enabled: false, token: '', chatId: '', proxyType: 'none', proxyUrl: '' },
    webhook: { enabled: false, url: '', method: 'POST', type: 'JSON', provider: 'generic', headers: '', secret: '', body: '' },
    serverchan: { enabled: false, sendKey: '' },
    pushplus: { enabled: false, token: '' },
    smtp: { enabled: false, host: '', port: 465, username: '', password: '', from: '', to: '' },
    template: { body: '' },
  },
  accounts: [],
};

function getString(row: Record<string, unknown> | null, key: string): string {
  return row == null ? '' : String(row[key] ?? '');
}
function getNumber(row: Record<string, unknown> | null, key: string): number {
  const v = row?.[key];
  if (v == null) return 0;
  return typeof v === 'number' ? v : parseFloat(String(v)) || 0;
}
function getBool(row: Record<string, unknown> | null, key: string): boolean {
  return row != null && !!row[key];
}

export async function getPasswordHash(env: Env): Promise<string> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind('admin_password_hash')
    .first();
  return row == null ? '' : getString(row, 'value');
}

export async function setPasswordHash(env: Env, hash: string): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,datetime('now'))")
    .bind('admin_password_hash', hash)
    .run();
}

export async function isInitialized(env: Env): Promise<boolean> {
  return (await getPasswordHash(env)) !== '';
}

// 监控防抖：距上次监控是否已超过配置间隔（分钟）
// 加 45 秒容差：外部定时器间隔与配置间隔相同时，若因执行耗时导致刚好差几秒，
// 会被误判为「过密」而跳过，实际退化成双倍间隔
export async function shouldRunMonitor(env: Env, intervalMinutes: number): Promise<boolean> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind('last_monitor_run')
    .first();
  if (!row) return true; // 首次运行
  const lastRun = parseInt(getString(row, 'value'), 10) || 0;
  const elapsed = Math.floor(Date.now() / 1000) - lastRun;
  return elapsed >= intervalMinutes * 60 - 45;
}

// 记录本次监控完成时间（Unix 秒）
export async function markMonitorRun(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,datetime(\'now\'))')
    .bind('last_monitor_run', String(now))
    .run();
}

export async function getConfig(env: Env): Promise<Config> {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
  const map = new Map<string, string>();
  for (const r of rows.results ?? []) {
    map.set(String(r.key), String(r.value));
  }
  const cfg: Config = structuredClone(DEFAULT_CONFIG);
  cfg.adminPasswordHash = map.get('admin_password_hash') ?? '';
  cfg.trafficThreshold = parseInt(map.get('traffic_threshold') ?? '95', 10) || 95;
  cfg.shutdownMode = map.get('shutdown_mode') ?? 'KeepCharging';
  cfg.thresholdAction = map.get('threshold_action') ?? 'stop_and_notify';
  cfg.apiInterval = parseInt(map.get('api_interval') ?? '600', 10) || 600;
  cfg.monitorInterval = parseInt(map.get('monitor_interval') ?? '5', 10) || 5;
  cfg.timezone = map.get('timezone') ?? 'Asia/Shanghai';
  cfg.keepAlive = map.get('keep_alive') === '1';
  cfg.enableBilling = map.get('enable_billing') === '1';
  cfg.enableScheduleMail = map.get('enable_schedule_mail') === '1';
  cfg.logRetentionDays = parseInt(map.get('log_retention_days') ?? '30', 10) || 30;
  // 通知配置从 JSON 字段读取：与默认值逐通道深合并。
  // 旧版本写入的配置可能缺少新通道键（smtp/serverchan/pushplus/template），
  // 整体替换会让下游 `n.smtp.password` 之类访问抛 TypeError，导致接口 500。
  const notifRaw = map.get('notifications');
  if (notifRaw) {
    try {
      const stored = JSON.parse(notifRaw) as Record<string, unknown>;
      const merged: Record<string, unknown> = {};
      for (const [chan, def] of Object.entries(cfg.notifications)) {
        const cur = stored[chan];
        merged[chan] = cur && typeof cur === 'object'
          ? { ...(def as Record<string, unknown>), ...(cur as Record<string, unknown>) }
          : def;
      }
      // 兼容最早的三通道版本：email → smtp（字段名不同，按需映射）
      const legacy = stored.email as Record<string, unknown> | undefined;
      if (legacy && typeof legacy === 'object') {
        merged.smtp = { ...(merged.smtp as Record<string, unknown>), ...legacy };
      }
      cfg.notifications = merged as unknown as Config['notifications'];
    } catch { /* 保留默认 */ }
  }
  cfg.accounts = await listAccounts(env);
  return cfg;
}

export async function listAccounts(env: Env): Promise<Account[]> {
  const rows = await env.DB.prepare('SELECT * FROM accounts ORDER BY id').all();
  const accounts: Account[] = [];
  for (const row of rows.results ?? []) {
    const r = row as Record<string, unknown>;
    accounts.push({
      id: getNumber(r, 'id'),
      name: getString(r, 'name'),
      remark: getString(r, 'remark'),
      regionId: getString(r, 'region_id'),
      instanceId: getString(r, 'instance_id'),
      accessKeyId: await decrypt(env, getString(r, 'access_key_id_enc')),
      accessKeySecret: await decrypt(env, getString(r, 'access_key_secret_enc')),
      siteType: (getString(r, 'site_type') as 'china' | 'international') || 'china',
      maxTraffic: getNumber(r, 'max_traffic'),
      startTime: getString(r, 'start_time'),
      stopTime: getString(r, 'stop_time'),
      scheduleEnabled: getBool(r, 'schedule_enabled'),
      keepAlive: getBool(r, 'keep_alive'),
      shutdownMode: getString(r, 'shutdown_mode'),
      instanceStatus: getString(r, 'instance_status'),
      trafficUsed: getNumber(r, 'traffic_used'),
      updatedAt: getString(r, 'updated_at'),
    });
  }
  return accounts;
}

export async function saveAccount(env: Env, account: Omit<Account, 'id'> & { id?: number }): Promise<number> {
  const akEnc = await encrypt(env, account.accessKeyId);
  const skEnc = await encrypt(env, account.accessKeySecret);
  // name 兜底：前端可不传，取备注或脱敏 AccessKey（D1 不接受 undefined 参数）
  const name = account.name || account.remark || (account.accessKeyId ? account.accessKeyId.slice(0, 7) + '***' : 'account');
  const remark = account.remark ?? '';
  const instanceId = account.instanceId ?? '';
  const startTime = account.startTime ?? '';
  const stopTime = account.stopTime ?? '';
  if (account.id) {
    await env.DB.prepare(
      `UPDATE accounts SET name=?, remark=?, region_id=?, instance_id=?, access_key_id_enc=?, access_key_secret_enc=?, site_type=?, max_traffic=?, start_time=?, stop_time=?, schedule_enabled=?, keep_alive=?, shutdown_mode=?, updated_at=datetime('now') WHERE id=?`,
    ).bind(
      name, remark, account.regionId, instanceId,
      akEnc, skEnc, account.siteType, account.maxTraffic, startTime, stopTime,
      account.scheduleEnabled ? 1 : 0, account.keepAlive ? 1 : 0, account.shutdownMode ?? '', account.id,
    ).run();
    return account.id;
  }
  const result = await env.DB.prepare(
    `INSERT INTO accounts (name, remark, region_id, instance_id, access_key_id_enc, access_key_secret_enc, site_type, max_traffic, start_time, stop_time, schedule_enabled, keep_alive, shutdown_mode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    name, remark, account.regionId, instanceId,
    akEnc, skEnc, account.siteType, account.maxTraffic, startTime, stopTime,
    account.scheduleEnabled ? 1 : 0, account.keepAlive ? 1 : 0, account.shutdownMode ?? '',
  ).run();
  return Number(result.meta.last_row_id ?? 0);
}

export async function deleteAccount(env: Env, id: number): Promise<void> {
  await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
}

// 更新已有账号的非敏感配置；AK/SK 仅在提供非空值时才覆盖（前端编辑弹窗留空=保持不变）
export async function updateAccountConfig(env: Env, a: Partial<Account> & { id: number }): Promise<void> {
  const remark = a.remark ?? '';
  const name = a.name || remark || 'account';
  const akEnc = a.accessKeyId ? await encrypt(env, a.accessKeyId) : null;
  const skEnc = a.accessKeySecret ? await encrypt(env, a.accessKeySecret) : null;
  const sql =
    `UPDATE accounts SET name=?, remark=?, region_id=?, instance_id=?, site_type=?, max_traffic=?, schedule_enabled=?, start_time=?, stop_time=?, shutdown_mode=?` +
    (akEnc ? ', access_key_id_enc=?' : '') +
    (skEnc ? ', access_key_secret_enc=?' : '') +
    `, updated_at=datetime('now') WHERE id=?`;
  const vals: unknown[] = [
    name, remark, a.regionId ?? '', a.instanceId ?? '', a.siteType ?? 'china',
    a.maxTraffic ?? 0, a.scheduleEnabled ? 1 : 0, a.startTime ?? '', a.stopTime ?? '', a.shutdownMode ?? '',
  ];
  if (akEnc) vals.push(akEnc);
  if (skEnc) vals.push(skEnc);
  vals.push(a.id);
  await env.DB.prepare(sql).bind(...vals).run();
}

export async function updateRuntime(
  env: Env,
  id: number,
  traffic: number,
  status: string,
  updatedAt: string,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE accounts SET traffic_used=?, instance_status=?, updated_at=? WHERE id=?",
  ).bind(traffic, status, updatedAt, id).run();
}

export async function addTrafficStat(env: Env, accountId: number, traffic: number, recordedAt: string): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO traffic_stats (account_id, traffic, recorded_at) VALUES (?,?,?)',
  ).bind(accountId, traffic, recordedAt).run();
}

export async function history(env: Env, accountId: number): Promise<{ traffic: number; recorded_at: string }[]> {
  const rows = await env.DB.prepare(
    'SELECT traffic, recorded_at FROM traffic_stats WHERE account_id = ? ORDER BY recorded_at DESC LIMIT 720',
  ).bind(accountId).all();
  return (rows.results ?? []) as { traffic: number; recorded_at: string }[];
}

export async function addLog(env: Env, type: string, message: string): Promise<void> {
  await env.DB.prepare('INSERT INTO logs (type, message) VALUES (?,?)').bind(type, message).run();
}

// 业务分类 → 底层日志类型集合（登录/监控/告警，其余归「全部」）
const LOG_CATEGORY_TYPES: Record<string, string[]> = {
  auth: ['audit'],
  monitor: ['heartbeat', 'info'],
  alert: ['warning', 'error'],
};

export interface LogPage {
  logs: { id: number; type: string; message: string; created_at: string }[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function listLogs(
  env: Env,
  category: string,
  page = 1,
  pageSize = 50,
): Promise<LogPage> {
  const safePage = Math.max(1, page);
  const safeSize = Math.min(100, Math.max(1, pageSize));
  const offset = (safePage - 1) * safeSize;

  let where = '';
  const params: unknown[] = [];
  if (category && category !== 'all' && LOG_CATEGORY_TYPES[category]) {
    const types = LOG_CATEGORY_TYPES[category];
    where = 'WHERE type IN (' + types.map(() => '?').join(',') + ')';
    params.push(...types);
  }

  const totalRow = await env.DB.prepare('SELECT COUNT(*) AS c FROM logs ' + where).bind(...params).first();
  const total = getNumber(totalRow, 'c');

  const rows = await env.DB.prepare(
    'SELECT * FROM logs ' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?',
  ).bind(...params, safeSize, offset).all();

  return {
    logs: (rows.results ?? []) as { id: number; type: string; message: string; created_at: string }[],
    total,
    page: safePage,
    pageSize: safeSize,
    totalPages: Math.max(1, Math.ceil(total / safeSize)),
  };
}

export async function clearLogs(env: Env, category: string): Promise<void> {
  if (category && category !== 'all' && LOG_CATEGORY_TYPES[category]) {
    const types = LOG_CATEGORY_TYPES[category];
    const where = 'WHERE type IN (' + types.map(() => '?').join(',') + ')';
    await env.DB.prepare('DELETE FROM logs ' + where).bind(...types).run();
  } else {
    await env.DB.prepare('DELETE FROM logs').run();
  }
}

// 清理超期日志：删除 created_at 早于 N 天的记录（幂等，返回删除条数）
// D1 的 datetime('now') 为 UTC，created_at 也是 datetime('now') 写入的 UTC 时间，可直接比较
export async function cleanupExpiredLogs(env: Env, retentionDays: number): Promise<number> {
  const days = Math.max(1, Math.floor(retentionDays));
  const result = await env.DB.prepare(
    "DELETE FROM logs WHERE created_at < datetime('now', '-? days')",
  ).bind(String(days)).run();
  // D1 的 run() 返回 meta.changes 可能不可靠，这里只返回执行状态（0 表示无超期或成功）
  return 0;
}

// 动作事件幂等键
export async function recordActionEvent(
  env: Env,
  key: string,
  accountId: number,
  type: string,
  state: string,
  detail = '',
): Promise<boolean> {
  const existing = await env.DB.prepare('SELECT key FROM action_events WHERE key = ?').bind(key).first();
  if (existing) return false;
  try {
    await env.DB.prepare(
      'INSERT INTO action_events (key, account_id, type, state, detail) VALUES (?,?,?,?,?)',
    ).bind(key, accountId, type, state, detail).run();
    return true;
  } catch {
    return false; // 唯一键冲突视为已存在
  }
}

export async function deleteActionEvent(env: Env, key: string): Promise<void> {
  await env.DB.prepare('DELETE FROM action_events WHERE key = ?').bind(key).run();
}

// 账单缓存
export async function billingCache<T>(
  env: Env,
  accountId: number,
  kind: string,
  cycle: string,
  ttlHours: number,
): Promise<{ hit: boolean; value?: T }> {
  const row = await env.DB.prepare(
    'SELECT value, updated_at FROM billing_cache WHERE account_id = ? AND kind = ? AND cycle = ?',
  ).bind(accountId, kind, cycle).first();
  if (!row) return { hit: false };
  // D1 的 datetime('now') 返回 UTC 无时区字符串（YYYY-MM-DD HH:MM:SS），需按 UTC 解析，
  // 否则 JS 会当本地时间解析导致 TTL 偏移（东八区会差 8 小时）
  const raw = String((row as Record<string, unknown>).updated_at ?? '');
  const utcMs = Date.parse(raw.replace(' ', 'T') + 'Z');
  const updatedMs = isNaN(utcMs) ? Date.parse(raw) : utcMs;
  if (Date.now() - updatedMs > ttlHours * 3600 * 1000) return { hit: false };
  try {
    return { hit: true, value: JSON.parse(String(row.value)) as T };
  } catch {
    return { hit: false };
  }
}

export async function setBillingCache(
  env: Env,
  accountId: number,
  kind: string,
  cycle: string,
  value: unknown,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO billing_cache (account_id, kind, cycle, value, updated_at) VALUES (?,?,?,?,datetime('now'))
     ON CONFLICT(account_id, kind, cycle) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`,
  ).bind(accountId, kind, cycle, JSON.stringify(value)).run();
}

// 通知 Outbox
export async function addOutbox(env: Env, channel: string, payload: unknown): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO notification_outbox (channel, payload, available_at) VALUES (?,?,unixepoch())',
  ).bind(channel, JSON.stringify(payload)).run();
}

export interface OutboxRow {
  id: number;
  channel: string;
  payload: string;
  status: string;
  updated_at: number;
}

// 取待发送的 outbox 记录（最早优先，限制批量防止单次超时）
export async function listPendingOutbox(env: Env, limit = 10): Promise<OutboxRow[]> {
  const rows = await env.DB.prepare(
    "SELECT id, channel, payload, status, updated_at FROM notification_outbox WHERE status = 'queued' AND available_at <= unixepoch() ORDER BY id LIMIT ?",
  ).bind(limit).all();
  return (rows.results ?? []) as unknown as OutboxRow[];
}

// 标记已发送
export async function markOutboxSent(env: Env, id: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE notification_outbox SET status = 'sent', error = '', updated_at = unixepoch() WHERE id = ?",
  ).bind(id).run();
}

// 发送失败：延迟 retrySeconds 后重试；若首条入队已超过 giveUpSeconds 则放弃
export async function markOutboxRetry(env: Env, id: number, error: string, retrySeconds: number, giveUpSeconds: number): Promise<'retry' | 'failed'> {
  const row = await env.DB.prepare('SELECT updated_at FROM notification_outbox WHERE id = ?').bind(id).first();
  const updatedAt = getNumber(row, 'updated_at');
  const age = Math.floor(Date.now() / 1000) - updatedAt;
  if (age >= giveUpSeconds) {
    await env.DB.prepare(
      "UPDATE notification_outbox SET status = 'failed', error = ?, updated_at = unixepoch() WHERE id = ?",
    ).bind(error.slice(0, 500), id).run();
    return 'failed';
  }
  await env.DB.prepare(
    "UPDATE notification_outbox SET error = ?, available_at = unixepoch() + ?, updated_at = unixepoch() WHERE id = ?",
  ).bind(error.slice(0, 500), retrySeconds, id).run();
  return 'retry';
}
