// 自动建表：部署后首次请求时幂等执行 schema
// 对应 schema.sql，全部用 IF NOT EXISTS 保证可重复执行
import type { Env } from '../security/security';
import { DEFAULT_CONFIG, addLog, type Config } from './store';

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
    cycle_enabled INTEGER NOT NULL DEFAULT 0,
    cycle_anchor TEXT NOT NULL DEFAULT '',
    cycle_days INTEGER NOT NULL DEFAULT 10,
    cycle_start_on INTEGER NOT NULL DEFAULT 1,
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
  // ── jobs 表（已废弃，仅保留 DROP 迁移防旧库报错）──
  // 历史遗留：早期设计曾把通知/账单查询做成 jobs 队列，现已被
  // notification_outbox（通知）+ billing_cache（账单）+ 监控内联执行取代。
  // 全代码库无任何读写（已核对）。建表语句已移除：此前每次冷启动
  // CREATE TABLE IF NOT EXISTS jobs 完又立刻 DROP TABLE IF EXISTS jobs，
  // 白白多一次 DDL 往返；保留 MIGRATIONS 里的 DROP 即可回收旧库残留。
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
    expires_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_login_ip ON login_attempts(ip, created_at)`,
  // 跨 isolate 限流计数桶：allowRateD1 用 D1 做第二道跨实例计数闸，
  // 弥补进程内 rateMap 在 Cloudflare 冷启动后失效的问题。单窗口一行，随窗口过期被下一请求重置覆盖。
  `CREATE TABLE IF NOT EXISTS rate_buckets (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    reset_at INTEGER NOT NULL
  )`,

  // ── DDNS 轮换解析 ──
  // 分组（一组机器 + 若干域名记录，同一分组下的域名永远指向同一台值班机器）
  `CREATE TABLE IF NOT EXISTS ddns_groups (
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
  )`,
  // 机器池（与阿里云账号解耦：这里只关心「名字 + 公网 IP」）
  `CREATE TABLE IF NOT EXISTS ddns_machines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    ip TEXT NOT NULL,
    remark TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  // 分组↔机器的成员关系与排班参数（days 用于 rotate，window_* 用于 window）
  `CREATE TABLE IF NOT EXISTS ddns_group_members (
    group_id INTEGER NOT NULL,
    machine_id INTEGER NOT NULL,
    days INTEGER NOT NULL DEFAULT 1,
    window_start TEXT NOT NULL DEFAULT '',
    window_end TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, machine_id),
    FOREIGN KEY (group_id) REFERENCES ddns_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (machine_id) REFERENCES ddns_machines(id) ON DELETE CASCADE
  )`,
  // 解析记录：一个分组可挂多条（多域名/跨厂商），全部同步指向本组值班机器
  `CREATE TABLE IF NOT EXISTS ddns_records (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ddns_records_group ON ddns_records(group_id)`,
  // DNS 厂商凭据（可被多条解析记录复用，与参考项目 ddns-rotation 的 credentials 对齐）
  // 凭据密文 AES-GCM 加密存储；记录通过 credential_id 引用，不再各自内嵌一份
  `CREATE TABLE IF NOT EXISTS ddns_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    credential_enc TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

// 已部署库的增量迁移（ALTER 在列已存在时会报错，需逐条容错执行）
//
// 为什么拆成 ADD_COLUMNS / OTHER_MIGRATIONS 两份：
// ensureSchema 每次冷启动都要跑一遍迁移。加列类迁移对**已升级过的库**必然因「列已存在」
// 失败并被 catch 吞掉——但失败的 ALTER 照样消耗一次 D1 调用。迁移条目累积到 10 条后，
// 这笔固定开销会挤占单次请求 50 subrequest 的预算（cron 每 5 分钟一轮，isolate 常已回收）。
// 故对加列类迁移先按表查一次 PRAGMA table_info 缓存列名，列已存在就整条跳过。
//
// 为什么 MIGRATIONS 仍由这两份拼装而成（而不是让调用方改用新结构）：
// test/outbox-backfill.test.ts 直接 import MIGRATIONS 并断言「ADD COLUMN created_at 必须排在
// 回填 UPDATE 之前」——顺序即正确性（先加列才能回填）。拼装保证数组内容与顺序不变，
// 且 SQL 字符串仍只有这一份，不会两处维护后漂移。
const ADD_COLUMNS: { sql: string; table: string; column: string }[] = [
  // 账号级停机模式：'' 表示跟随系统全局设置，StopCharging/KeepCharging 覆盖全局
  { table: 'accounts', column: 'shutdown_mode', sql: `ALTER TABLE accounts ADD COLUMN shutdown_mode TEXT NOT NULL DEFAULT ''` },
  // 「基准时间 + N 天循环开关机」：与每日定时（schedule_enabled）互斥。
  // cycle_anchor 为基准时间 "YYYY-MM-DD HH:mm:ss"（按全局时区解释）；cycle_days 为一个相位的天数。
  { table: 'accounts', column: 'cycle_enabled', sql: `ALTER TABLE accounts ADD COLUMN cycle_enabled INTEGER NOT NULL DEFAULT 0` },
  { table: 'accounts', column: 'cycle_anchor', sql: `ALTER TABLE accounts ADD COLUMN cycle_anchor TEXT NOT NULL DEFAULT ''` },
  { table: 'accounts', column: 'cycle_days', sql: `ALTER TABLE accounts ADD COLUMN cycle_days INTEGER NOT NULL DEFAULT 10` },
  // 循环首个相位的状态：1=开机（默认）/ 0=关机。默认 1 保证老数据升级后行为不变
  // （历史语义就是「首个 N 天开机」），不会被静默反相。
  { table: 'accounts', column: 'cycle_start_on', sql: `ALTER TABLE accounts ADD COLUMN cycle_start_on INTEGER NOT NULL DEFAULT 1` },
  // 解析记录改为引用独立凭据：新增 credential_id（0 表示尚未绑定凭据）
  { table: 'ddns_records', column: 'credential_id', sql: `ALTER TABLE ddns_records ADD COLUMN credential_id INTEGER NOT NULL DEFAULT 0` },
  // 分组新增「基准时间」（interval 模式：精确到分钟的轮换起点）
  { table: 'ddns_groups', column: 'anchor_at', sql: `ALTER TABLE ddns_groups ADD COLUMN anchor_at TEXT NOT NULL DEFAULT ''` },
  // P1-11：outbox 增加入队时间。此前「超过 24 小时放弃」用的是 updated_at，
  // 而 updated_at 每次重试都会被刷成当前时间，于是 age 实际衡量的是「距上次重试」——
  // 重试间隔 300s 远小于放弃阈值 24h，记录永远不会被放弃，失败通知会无限重试下去。
  { table: 'notification_outbox', column: 'created_at', sql: `ALTER TABLE notification_outbox ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0` },
];

// 非加列类迁移：无法用「列是否存在」跳过，仍需逐条容错执行。
const OTHER_MIGRATIONS: string[] = [
  // jobs 表早已零引用（通知走 notification_outbox、账单走 billing_cache），直接回收
  `DROP TABLE IF EXISTS jobs`,
  // P0-R5-2（修复本轮引入的回归）：上一行只加了列没回填。存量老行 created_at=0 →
  // NULLIF 得 NULL → COALESCE 退回 updated_at=0 → unixepoch()-0 巨大 → markOutboxRetry
  // 的放弃判定直接命中 → 部署当口的待发通知首次失败即被标记为 failed、再无重试机会。
  // 存量行用真实 updated_at（若非 0）回填入队时间，都没有则视作刚入队（unixepoch()）。
  // 顺序要求：必须排在 ADD_COLUMNS 的 created_at 之后（先有列才能回填）。
  `UPDATE notification_outbox SET created_at = COALESCE(NULLIF(updated_at, 0), unixepoch()) WHERE created_at = 0`,
];

export const MIGRATIONS: string[] = [
  ...ADD_COLUMNS.map((c) => c.sql),
  ...OTHER_MIGRATIONS,
];

/** sql → 所属表/列，供 ensureSchema 决定能否跳过 */
const ADD_COLUMN_BY_SQL = new Map(ADD_COLUMNS.map((c) => [c.sql, c]));

/**
 * 默认设置项：首次部署写入；已部署库仅补齐缺失的键（INSERT OR IGNORE 不覆盖现有值）。
 * 唯一数据源是 store.ts 的 DEFAULT_CONFIG，这里只描述「settings key ↔ Config 字段」的映射，
 * 避免默认值在两个文件里各写一份后漂移（历史上 enable_status_change_notify 就只在 DEFAULT_CONFIG 里）。
 *
 * P2-9：原来这份映射是裸数组，漏写一项照样编译通过，只能在运行时表现为
 * 「新设置项首次部署没写库 → 读不到 → 静默用默认值」，排查成本很高。
 * 改为 Record<SettingKey, ...>：SettingKey 由 Config 的标量字段自动推导
 * （排除 notifications / accounts 这两个不落 settings 表的复合字段，以及 adminPasswordHash 这个由初始化流程单独处理的字段），
 * 于是**给 Config 新增标量字段时，这里漏写会直接编译报错**。
 */
type SettingKey = Exclude<keyof Config, 'notifications' | 'accounts' | 'adminPasswordHash'>;

const DEFAULT_SETTINGS_MAP: Record<SettingKey, [string, string]> = {
  // adminPasswordHash 已从 SettingKey 排除（见上方 type 的 Exclude），不落 settings 表、由初始化流程单独写入。
  trafficThreshold: ['traffic_threshold', String(DEFAULT_CONFIG.trafficThreshold)],
  shutdownMode: ['shutdown_mode', DEFAULT_CONFIG.shutdownMode],
  thresholdAction: ['threshold_action', DEFAULT_CONFIG.thresholdAction],
  apiInterval: ['api_interval', String(DEFAULT_CONFIG.apiInterval)],
  monitorInterval: ['monitor_interval', String(DEFAULT_CONFIG.monitorInterval)],
  timezone: ['timezone', DEFAULT_CONFIG.timezone],
  keepAlive: ['keep_alive', DEFAULT_CONFIG.keepAlive ? '1' : '0'],
  enableBilling: ['enable_billing', DEFAULT_CONFIG.enableBilling ? '1' : '0'],
  enableScheduleMail: ['enable_schedule_mail', DEFAULT_CONFIG.enableScheduleMail ? '1' : '0'],
  logRetentionDays: ['log_retention_days', String(DEFAULT_CONFIG.logRetentionDays)],
  enableStatusChangeNotify: ['enable_status_change_notify', DEFAULT_CONFIG.enableStatusChangeNotify ? '1' : '0'],
};

// adminPasswordHash 已由 SettingKey 排除，DEFAULT_SETTINGS_MAP 不再含该占位键
const DEFAULT_SETTINGS: [string, string][] = Object.values(DEFAULT_SETTINGS_MAP);

/**
 * 把历史上「每条解析记录内嵌一份凭据」的旧数据，迁移为独立的 ddns_credentials
 * 记录并通过 credential_id 引用。
 *
 * 直接复制密文（credential_enc）而不再解密重加密：同一把密钥、同一套 AES-GCM，
 * 密文可直接搬移，避免迁移期间的加解密开销与失败面。
 *
 * 幂等：仅处理 credential_id=0 且 credential_enc 非空的记录；迁移后 credential_id>0，
 * 重复执行不会再次命中。
 */
async function migrateInlineCredentials(env: Env): Promise<void> {
  const res = await env.DB.prepare(
    `SELECT id, provider, zone, credential_enc FROM ddns_records
     WHERE credential_id = 0 AND credential_enc <> ''`,
  ).all();
  const rows = (res.results || []) as unknown as {
    id: number; provider: string; zone: string; credential_enc: string;
  }[];
  if (!rows.length) return;
  // P1-10：原实现是「每条记录 2 次独立 run()」——50 条遗留记录就是冷启动 +100 个
  // subrequest，直接撞 Cloudflare 上限并 1102。改为 2 次调用：
  //   ① 一条 batch 插入全部凭据（D1 的 batch 只算 1 个 subrequest）
  //   ② 一条 UPDATE 用子查询按密文回填引用（密文相同即同一份凭据，选哪条等价）
  await env.DB.batch(
    rows.map((r) =>
      env.DB.prepare('INSERT INTO ddns_credentials (name, provider, credential_enc) VALUES (?,?,?)')
        .bind(`${r.provider} · ${r.zone}`, r.provider, r.credential_enc),
    ),
  );
  // COALESCE 兜底：万一某条没匹配到（如并发插入），退回 0 而不是写 NULL 破坏 NOT NULL 约束
  await env.DB.prepare(
    `UPDATE ddns_records SET credential_id = COALESCE((
       SELECT c.id FROM ddns_credentials c
       WHERE c.credential_enc = ddns_records.credential_enc AND c.provider = ddns_records.provider
     ), 0)
     WHERE credential_id = 0 AND credential_enc <> ''`,
  ).run();
}

/**
 * 查某表是否已存在指定列（结果按表缓存，一个 isolate 内每张表只查一次 PRAGMA）。
 *
 * 容错优先：PRAGMA 不被支持或查询失败时返回 **false**（当作「列不存在」），
 * 于是调用方仍会照原样执行 ALTER，由 duplicate column 的 catch 兜住 ——
 * 也就是说这条优化路径**只会省调用，不会漏建列**，最坏情况退化成改动前的行为。
 *
 * 表名全部来自 ADD_COLUMNS 常量（非用户输入），故 PRAGMA 拼接无注入面。
 */
async function hasColumn(
  env: Env,
  cache: Map<string, Set<string>>,
  table: string,
  column: string,
): Promise<boolean> {
  let cols = cache.get(table);
  if (!cols) {
    cols = new Set<string>();
    try {
      const res = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
      for (const r of (res.results ?? []) as { name?: unknown }[]) {
        if (r && typeof r.name === 'string') cols.add(r.name);
      }
    } catch {
      // 查不到就当作「不知道有哪些列」——缓存保持空集，后续一律走原 ALTER 逻辑
    }
    cache.set(table, cols);
  }
  return cols.has(column);
}

let schemaReady = false;
// P2-R4-2：遗留凭据迁移的失败次数。迁移失败时**不置** schemaReady，让下个请求再试一次；
// 达到上限后放弃重试，否则每个请求都会重跑一遍建表 batch，把 D1 写打满。
let migrateFailures = 0;
// P1-7：迁移是否**本次**成功。必须显式记录，不能由「migrateFailures === 0」推导——
// 计数器只在失败时递增、成功时不变，于是「先失败一次、随后成功」会让它永远停在 1，
// 导致 schemaReady 恒为 false、每个请求都重跑一遍完整建表流程（数十个 D1 写）。
// 这是 8e8e645 引入的回归：用计数器间接推导成功，语义太脆弱。
let migrationOk = false;
const MIGRATE_MAX_ATTEMPTS = 3;

// 幂等建表 + 增量迁移 + 默认值补齐，多次调用只真正执行一次（进程内标记）
export async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  const statements = SCHEMA_STATEMENTS.map((sql) => env.DB.prepare(sql));
  await env.DB.batch(statements);
  // 迁移逐条容错：列已存在（duplicate column）时忽略，不影响其他迁移。
  // 加列类迁移先查列名缓存：列已在 → 整条跳过，省下一次必然失败的 D1 调用
  // （失败的 ALTER 同样算一次查询，迁移累积后这笔固定开销会挤占 50 subrequest 预算）。
  const tableColumns = new Map<string, Set<string>>();
  for (const sql of MIGRATIONS) {
    const meta = ADD_COLUMN_BY_SQL.get(sql);
    if (meta && await hasColumn(env, tableColumns, meta.table, meta.column)) continue;
    try {
      await env.DB.prepare(sql).run();
    } catch { /* 已应用过，忽略 */ }
  }
  // 数据迁移：把历史上内嵌在解析记录里的凭据提升为独立凭据并回填引用
  try {
    await migrateInlineCredentials(env);
    migrationOk = true; // P1-7：显式置位，成功即成功
  } catch (e) {
    migrateFailures++;
    const detail = e instanceof Error ? e.message : String(e);
    // P2-5：迁移失败不可静默吞掉；P2-R4-2：顺带说明接下来还会不会重试
    const tail = migrateFailures >= MIGRATE_MAX_ATTEMPTS
      ? '（已达重试上限，本 isolate 不再重试：需修复脏数据后重新部署才会再次迁移）'
      : `（第 ${migrateFailures}/${MIGRATE_MAX_ATTEMPTS} 次，下个请求会重试）`;
    await addLog(env, 'error', 'DDNS 遗留凭据迁移失败：' + detail + tail).catch(() => {});
  }
  // 补齐缺失的设置默认值（已存在的不覆盖）
  try {
    await env.DB.batch(
      DEFAULT_SETTINGS.map(([k, v]) =>
        env.DB.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)').bind(k, v),
      ),
    );
  } catch { /* 默认值写入失败不影响启动 */ }
  // P2-R4-2 + P1-7：本次迁移成功 → 完成；失败且未达上限 → 不置 true，下个请求重试；
  // 失败达上限 → 放弃重试，避免每个请求都重跑一遍建表 batch 把 D1 写打满
  schemaReady = migrationOk || migrateFailures >= MIGRATE_MAX_ATTEMPTS;
}
