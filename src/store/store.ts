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
  notifications: {
    email: { enabled: boolean; host: string; port: number; username: string; password: string; security: string; to: string };
    telegram: { enabled: boolean; token: string; chatId: string; proxyType: string; proxyUrl: string };
    webhook: { enabled: boolean; url: string; method: string; type: string; provider: string; headers: string; secret: string; body: string };
  };
  accounts: Account[];
}

const DEFAULT_CONFIG: Config = {
  adminPasswordHash: '',
  trafficThreshold: 95,
  shutdownMode: 'KeepCharging',
  thresholdAction: 'stop_and_notify',
  apiInterval: 600,
  monitorInterval: 5,
  timezone: 'Asia/Shanghai',
  keepAlive: false,
  enableBilling: false,
  enableScheduleMail: false,
  notifications: {
    email: { enabled: false, host: '', port: 465, username: '', password: '', security: 'ssl', to: '' },
    telegram: { enabled: false, token: '', chatId: '', proxyType: 'none', proxyUrl: '' },
    webhook: { enabled: false, url: '', method: 'GET', type: 'JSON', provider: 'generic', headers: '', secret: '', body: '' },
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
export async function shouldRunMonitor(env: Env, intervalMinutes: number): Promise<boolean> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?')
    .bind('last_monitor_run')
    .first();
  if (!row) return true; // 首次运行
  const lastRun = parseInt(getString(row, 'value'), 10) || 0;
  const elapsed = Math.floor(Date.now() / 1000) - lastRun;
  return elapsed >= intervalMinutes * 60;
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
  // 通知配置从 JSON 字段读取
  const notifRaw = map.get('notifications');
  if (notifRaw) {
    try {
      cfg.notifications = JSON.parse(notifRaw);
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
  if (account.id) {
    await env.DB.prepare(
      `UPDATE accounts SET name=?, remark=?, region_id=?, instance_id=?, access_key_id_enc=?, access_key_secret_enc=?, site_type=?, max_traffic=?, start_time=?, stop_time=?, schedule_enabled=?, keep_alive=?, updated_at=datetime('now') WHERE id=?`,
    ).bind(
      account.name, account.remark, account.regionId, account.instanceId,
      akEnc, skEnc, account.siteType, account.maxTraffic, account.startTime, account.stopTime,
      account.scheduleEnabled ? 1 : 0, account.keepAlive ? 1 : 0, account.id,
    ).run();
    return account.id;
  }
  const result = await env.DB.prepare(
    `INSERT INTO accounts (name, remark, region_id, instance_id, access_key_id_enc, access_key_secret_enc, site_type, max_traffic, start_time, stop_time, schedule_enabled, keep_alive) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    account.name, account.remark, account.regionId, account.instanceId,
    akEnc, skEnc, account.siteType, account.maxTraffic, account.startTime, account.stopTime,
    account.scheduleEnabled ? 1 : 0, account.keepAlive ? 1 : 0,
  ).run();
  return Number(result.meta.last_row_id ?? 0);
}

export async function deleteAccount(env: Env, id: number): Promise<void> {
  await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
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

export async function listLogs(env: Env, type: string, limit = 100): Promise<{ id: number; type: string; message: string; created_at: string }[]> {
  const rows = type
    ? await env.DB.prepare('SELECT * FROM logs WHERE type = ? ORDER BY id DESC LIMIT ?').bind(type, limit).all()
    : await env.DB.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').bind(limit).all();
  return (rows.results ?? []) as { id: number; type: string; message: string; created_at: string }[];
}

export async function clearLogs(env: Env, type: string): Promise<void> {
  if (type) {
    await env.DB.prepare('DELETE FROM logs WHERE type = ?').bind(type).run();
  } else {
    await env.DB.prepare('DELETE FROM logs').run();
  }
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
  const updatedAt = new Date(String(row.updated_at));
  if (Date.now() - updatedAt.getTime() > ttlHours * 3600 * 1000) return { hit: false };
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
