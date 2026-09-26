// 自动建表：部署后首次请求时幂等执行 schema
// 对应 schema.sql，全部用 IF NOT EXISTS 保证可重复执行
import type { Env } from '../security/security';

const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    remark TEXT NOT NULL DEFAULT '',
    region_id TEXT NOT NULL,
    instance_id TEXT NOT NULL DEFAULT '',
    access_key_id_enc TEXT NOT NULL,
    access_key_secret_enc TEXT NOT NULL,
    site_type TEXT NOT NULL DEFAULT 'china',
    max_traffic REAL NOT NULL DEFAULT 0,
    start_time TEXT NOT NULL DEFAULT '',
    stop_time TEXT NOT NULL DEFAULT '',
    schedule_enabled INTEGER NOT NULL DEFAULT 0,
    keep_alive INTEGER NOT NULL DEFAULT 0,
    instance_status TEXT NOT NULL DEFAULT 'Unknown',
    traffic_used REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS traffic_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    traffic REAL NOT NULL,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_traffic_account_time ON traffic_stats(account_id, recorded_at)`,
  `CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_logs_type_time ON logs(type, created_at)`,
  `CREATE TABLE IF NOT EXISTS billing_cache (
    account_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    cycle TEXT NOT NULL DEFAULT '',
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (account_id, kind, cycle)
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    account_id INTEGER NOT NULL,
    payload TEXT NOT NULL,
    unique_key TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    result TEXT,
    locked_at INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, available_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_unique ON jobs(unique_key) WHERE unique_key IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS action_events (
    key TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    state TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS notification_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    error TEXT,
    available_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_status ON notification_outbox(status, available_at)`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    ip TEXT NOT NULL,
    user_agent TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    scopes TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip, created_at)`,
];

// 已部署库的增量迁移（ALTER 在列已存在时会报错，需逐条容错执行）
const MIGRATIONS: string[] = [
  // 账号级停机模式：'' 表示跟随系统全局设置，StopCharging/KeepCharging 覆盖全局
  `ALTER TABLE accounts ADD COLUMN shutdown_mode TEXT NOT NULL DEFAULT ''`,
];

let schemaReady = false;

// 幂等建表 + 增量迁移，多次调用只真正执行一次（进程内标记）
export async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  const statements = SCHEMA_STATEMENTS.map((sql) => env.DB.prepare(sql));
  await env.DB.batch(statements);
  // 迁移逐条容错：列已存在（duplicate column）时忽略，不影响其他迁移
  for (const sql of MIGRATIONS) {
    try {
      await env.DB.prepare(sql).run();
    } catch { /* 已应用过，忽略 */ }
  }
  schemaReady = true;
}
