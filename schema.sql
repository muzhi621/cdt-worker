-- CDT Monitor Worker 版 D1 schema
-- 对应原 Go 项目 internal/store/migrations.go
-- 账号、配置、流量统计、日志、账单缓存、任务、通知 Outbox、会话、API Key

-- 全局设置（键值对，敏感字段加密存储）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 阿里云账号
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,               -- 脱敏展示名
  remark TEXT NOT NULL DEFAULT '',
  region_id TEXT NOT NULL,
  instance_id TEXT NOT NULL DEFAULT '',
  access_key_id_enc TEXT NOT NULL,       -- AES-GCM 加密
  access_key_secret_enc TEXT NOT NULL,   -- AES-GCM 加密
  site_type TEXT NOT NULL DEFAULT 'china',
  max_traffic REAL NOT NULL DEFAULT 0,
  start_time TEXT NOT NULL DEFAULT '',
  stop_time TEXT NOT NULL DEFAULT '',
  schedule_enabled INTEGER NOT NULL DEFAULT 0,
  cycle_enabled INTEGER NOT NULL DEFAULT 0,   -- 基准时间+N天循环开关机（与每日定时互斥）
  cycle_anchor TEXT NOT NULL DEFAULT '',      -- 基准时间 "YYYY-MM-DD HH:mm:ss"（按全局时区解释）
  cycle_days INTEGER NOT NULL DEFAULT 10,     -- 一个相位的天数
  cycle_start_on INTEGER NOT NULL DEFAULT 1,   -- 循环首个相位状态：1=开机（默认）/ 0=关机
  keep_alive INTEGER NOT NULL DEFAULT 0,
  instance_status TEXT NOT NULL DEFAULT 'Unknown',
  traffic_used REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 流量历史（小时/天聚合）
CREATE TABLE IF NOT EXISTS traffic_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  traffic REAL NOT NULL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_traffic_account_time ON traffic_stats(account_id, recorded_at);

-- 日志
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,  -- info/warning/error/audit/heartbeat
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_logs_type_time ON logs(type, created_at);

-- 账单缓存
CREATE TABLE IF NOT EXISTS billing_cache (
  account_id INTEGER NOT NULL,
  kind TEXT NOT NULL,        -- balance / instance_bill / error
  cycle TEXT NOT NULL DEFAULT '',
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (account_id, kind, cycle)
);

-- 后台任务队列
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,        -- monitor_account / refresh_account / control_instance
  account_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  unique_key TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  result TEXT,
  locked_at INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, available_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_unique ON jobs(unique_key) WHERE unique_key IS NOT NULL;

-- 动作事件（幂等键，等价原 action_events）
CREATE TABLE IF NOT EXISTS action_events (
  key TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  state TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 通知 Outbox
CREATE TABLE IF NOT EXISTS notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  available_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON notification_outbox(status, available_at);

-- 管理员会话
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  ip TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- API Key（只存哈希）
CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL,  -- JSON 数组
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at TEXT
);

-- 登录失败记录
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip, created_at);

-- ─────────────────────────── DDNS 轮换解析 ───────────────────────────
-- 与 src/store/schema.ts 保持一致（运行时 ensureSchema 也会幂等建表）

-- 分组（一组机器 + 若干域名记录，同组域名永远指向同一台值班机器）
-- mode: rotate 按天轮换 / interval 基准时间+每N天 / window 一天内时段 / static 固定首台
CREATE TABLE IF NOT EXISTS ddns_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'rotate',
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  switch_time TEXT NOT NULL DEFAULT '03:00',
  anchor_date TEXT NOT NULL DEFAULT '1970-01-01',
  anchor_at TEXT NOT NULL DEFAULT '',
  fallback_ip TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 机器池（只关心「名称 + 公网 IP」，开关机由云厂商控制台负责）
CREATE TABLE IF NOT EXISTS ddns_machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ip TEXT NOT NULL,
  remark TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 分组↔机器的成员关系与排班参数（days 用于 rotate/interval，window_* 用于 window）
CREATE TABLE IF NOT EXISTS ddns_group_members (
  group_id INTEGER NOT NULL,
  machine_id INTEGER NOT NULL,
  days INTEGER NOT NULL DEFAULT 1,
  window_start TEXT NOT NULL DEFAULT '',
  window_end TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, machine_id),
  FOREIGN KEY (group_id) REFERENCES ddns_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (machine_id) REFERENCES ddns_machines(id) ON DELETE CASCADE
);

-- DNS 厂商凭据（可被多条解析记录复用；AES-GCM 加密存储）
CREATE TABLE IF NOT EXISTS ddns_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  credential_enc TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 解析记录：一个分组可挂多条（多域名/跨厂商），全部同步指向本组值班机器
-- credential_id 引用 ddns_credentials；credential_enc 为历史遗留内嵌凭据（迁移后已弃用）
CREATE TABLE IF NOT EXISTS ddns_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  zone TEXT NOT NULL,
  host TEXT NOT NULL DEFAULT '@',
  ttl INTEGER NOT NULL DEFAULT 60,
  zone_id TEXT NOT NULL DEFAULT '',
  record_id TEXT NOT NULL DEFAULT '',
  credential_id INTEGER NOT NULL DEFAULT 0,
  credential_enc TEXT NOT NULL DEFAULT '',
  current_ip TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (group_id) REFERENCES ddns_groups(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ddns_records_group ON ddns_records(group_id);
