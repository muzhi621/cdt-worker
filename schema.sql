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
  expires_at TEXT,
  revoked_at TEXT
);

-- 登录失败记录
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip, created_at);
