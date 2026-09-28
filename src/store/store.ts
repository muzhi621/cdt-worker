// 数据访问层：D1 绑定，对应原 Go 项目 internal/store/
// 所有账号凭据字段在存取时做 AES-GCM 加密/解密

import { encrypt, decrypt, isEncrypted, type Env } from '../security/security';
import type { Account } from '../provider/aliyun';
import {
  parseTriggerSeen, parseTriggerSources, type TriggerSource,
} from '../engine/triggers';

// 通知通道里的敏感字段：与 AK/SK 同等对待，落库前 AES-GCM 加密、读库后解密。
// 此前这些字段（telegram token / smtp password / webhook secret 等）在 D1 里是明文，
// 与 AK/SK 的加密存储不一致——一旦 D1 备份/导出泄露，等于把通知渠道的凭据也一并交出去。
const NOTIFY_SECRET_PATHS: [string, string][] = [
  ['telegram', 'token'],
  ['webhook', 'secret'],
  ['serverchan', 'sendKey'],
  ['pushplus', 'token'],
  ['smtp', 'password'],
];

// 把通知配置里的敏感字段逐个加密（仅加密非空、且尚未加密的明文值）。
// 已带 enc:v1: 前缀的值跳过（幂等，避免重复加密），保证旧库明文可平滑迁移：
// 首次保存即加密，读侧 decrypt 对非 enc 前缀原样透传，读旧数据也不会崩。
export async function encryptNotifyConfig(env: Env, cfg: Record<string, unknown>): Promise<Record<string, unknown>> {
  for (const [chan, field] of NOTIFY_SECRET_PATHS) {
    const obj = cfg[chan];
    if (!obj || typeof obj !== 'object') continue;
    const o = obj as Record<string, unknown>;
    const v = o[field];
    if (typeof v !== 'string' || v === '' || isEncrypted(v)) continue;
    o[field] = await encrypt(env, v);
  }
  return cfg;
}

// 读取侧：把加密的敏感字段还原为明文供投递使用。非 enc 前缀（旧库明文）原样透传，
// 解密失败（主密钥更换等）时回退为空串并留一条 error 日志——避免一条坏数据让整个通知配置不可用，
// 但也不能完全静默：主密钥轮换会让 5 个通知凭据同时解密失败、通知无声停摆，
// 对一个靠告警活着的项目，这是最难发现的一类故障，至少要让日志页能自查。
export async function decryptNotifyConfig(env: Env, cfg: Record<string, unknown>): Promise<Record<string, unknown>> {
  for (const [chan, field] of NOTIFY_SECRET_PATHS) {
    const obj = cfg[chan];
    if (!obj || typeof obj !== 'object') continue;
    const o = obj as Record<string, unknown>;
    const v = o[field];
    if (typeof v !== 'string' || v === '') continue;
    try {
      o[field] = await decrypt(env, v);
    } catch {
      o[field] = '';
      // 留痕但不抛出：解密失败是异常情况，宁可在日志页吵一点，也不要无声失效
      void addLog(env, 'error',
        `通知凭据解密失败，该通道将发送失败：${chan}.${field}（检查 CDT_MASTER_KEY 是否变更）`)
        .catch(() => {});
    }
  }
  return cfg;
}

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
  enableStatusChangeNotify: boolean; // 实例状态 Running <-> Stopped 变化时发送通知
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

// 全项目唯一的默认配置源：schema.ts 的 settings 默认值也从这里派生，避免两处漂移
export const DEFAULT_CONFIG: Config = {
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
  enableStatusChangeNotify: true,
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

// 解析 settings 里的整数并夹取到 [min, max]。核心目的：抵御 `parseInt || 默认` 的假值陷阱
// （"-50"/"1e9" 会穿透成 -50/1，而非回退默认值），把超出合理范围的脏值钳制到最近边界，
// 避免 threshold=-50 之类让 `percentage >= threshold` 恒真、进而触发全量停机。
// 无法解析（NaN / 空串 / 非数字前缀）时返回 fallback。
export function clampInt(raw: string | undefined, min: number, max: number, fallback: number): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// 与 clampInt 的区别：非法（NaN / 越界）时返回 null 供调用方拒绝（400），而不是悄悄回退。
// 「未传」语义（undefined / null / 空串）返回 fallback 放行——调用方自行决定是否落库。
// ⚠️ 回归教训：542c57a 曾在 saveConfig 里把「未传 logRetentionDays」映射成 null 再与
// 「非法值也是 null」共用同一个 400 判断，导致所有不携带该字段的 /api/v1/config 保存
// （含账号配置、保活开关）全部被 400 拒绝且界面报「日志保留天数必须在 1~365 之间」。
// 「未传」与「非法」必须走不同分支，绝不能共用同一个哨兵值。
export function parseClampedNum(raw: unknown, min: number, max: number, fallback: number): number | null {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null; // 无法解析 → 拒绝
  if (n < min || n > max) return null;  // 越界 → 拒绝
  return Math.round(n);
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

// 原子抢占监控槽位：仅当距上次运行超过 debounceSeconds 时，才把 last_monitor_run 更新为 now。
// 用条件 UPSERT 实现"检查 + 占位"的单语句原子操作（SQLite 写串行化，冲突分支的 WHERE
// 在更新时重新求值），并发触发只有一个能把 meta.changes 写成 1，其余全部返回 false。
// 替代旧的「读 → 判断 → 末尾写回」三步防抖：那套写法在并发触发时会重复跑整轮监控。
export async function tryAcquireMonitorSlot(env: Env, debounceSeconds: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const threshold = now - Math.max(0, debounceSeconds);
  const result = await env.DB.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('last_monitor_run', ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
     WHERE CAST(settings.value AS INTEGER) <= ?`,
  ).bind(String(now), String(threshold)).run();
  if ((result.meta?.changes ?? 0) === 1) return true;
  // 兜底：个别 D1 版本对 UPSERT 的 meta.changes 不可靠，回读校验值是否为本轮写入
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'last_monitor_run'").first();
  return String((row as Record<string, unknown> | null)?.value ?? '') === String(now);
}

// ─────────────────────────────────────────────────────────────
// 触发密钥（CRON_SECRET）的 D1 托管
// Cloudflare 的 Worker Secret 只写不可读：忘了只能重置，且所有渠道要跟着换值。
// 托管一份加密值（AES-GCM，复用 CDT_MASTER_KEY，与 AK/SK 同等强度）后，
// 管理台即可查看/修改。读取优先级：D1 托管值 > env.CRON_SECRET（未托管时的兜底）。
// ─────────────────────────────────────────────────────────────
const CRON_SECRET_KEY = 'cron_secret';

// isolate 级缓存：resolveCronSecret 每轮监控 + 每次 /__cron 请求都会调一次，
// 而 D1 托管密钥极少变动，缓存后可省掉每轮 1 次 D1 读 + 1 次 AES 解密（CPU 热点）。
// 缓存的是「解密后的明文」——仅存活于当前 isolate 内存，不落盘、不出 isolate。
// 失效时机：setCronSecret（管理台修改/清除）时主动清空；TTL 到期自动重读；isolate 回收自然重置。
// TTL 为什么不能太长：管理员改密钥是安全操作（怀疑泄露），其他 isolate 里缓存的旧明文
// 若不过期，仍可继续用于 /__cron 鉴权——残留窗口越短越好。60s 对每 5 分钟一轮的 cron 无感。
let cronSecretCache: { value: string; at: number } | undefined;
const CRON_SECRET_CACHE_TTL_MS = 60_000;

// 仅供测试/诊断重置缓存（正常运行时缓存由 setCronSecret 主动失效、TTL 到期、isolate 回收自然重置）
export function resetCronSecretCache(): void {
  cronSecretCache = undefined;
}

export async function resolveCronSecret(env: Env): Promise<string> {
  if (cronSecretCache && Date.now() - cronSecretCache.at < CRON_SECRET_CACHE_TTL_MS) {
    return cronSecretCache.value;
  }
  cronSecretCache = undefined; // 过期：清掉旧值，重新读库
  const row = await env.DB.prepare(`SELECT value FROM settings WHERE key = '${CRON_SECRET_KEY}'`).first();
  const stored = String((row as Record<string, unknown> | null)?.value ?? '');
  if (stored) {
    try {
      cronSecretCache = { value: await decrypt(env, stored), at: Date.now() };
    } catch {
      // 解密失败（主密钥更换等）时回退 env，且不缓存（下次仍重试解密，可能主密钥已恢复）
      return (env as unknown as { CRON_SECRET?: string }).CRON_SECRET ?? '';
    }
  } else {
    // 无托管值：回退 env.CRON_SECRET。这里缓存的是「最终生效值」（即 env 值），
    // 因为 env 在 isolate 内固定，缓存后每轮省一次 D1 读仍安全。
    cronSecretCache = { value: (env as unknown as { CRON_SECRET?: string }).CRON_SECRET ?? '', at: Date.now() };
  }
  return cronSecretCache.value;
}

// value 传空串 = 清除托管，鉴权回退到 Worker Secret
export async function setCronSecret(env: Env, value: string): Promise<void> {
  if (!value) {
    await env.DB.prepare(`DELETE FROM settings WHERE key = '${CRON_SECRET_KEY}'`).run();
    // 清除托管后回退 env：缓存 env 值（isolate 内固定），下次 resolve 省一次 D1 读
    cronSecretCache = { value: (env as unknown as { CRON_SECRET?: string }).CRON_SECRET ?? '', at: Date.now() };
    return;
  }
  await env.DB
    .prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('${CRON_SECRET_KEY}', ?, datetime('now'))`)
    .bind(await encrypt(env, value))
    .run();
  cronSecretCache = { value, at: Date.now() }; // 直接以明文更新缓存，省一次解密
}

// 是否已托管（只回布尔语义，不返回明文）：用于前端区分「托管值」与「Worker Secret」
export async function hasStoredCronSecret(env: Env): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS x FROM settings WHERE key = '${CRON_SECRET_KEY}'`).first();
  return !!row;
}

// ─────────────────────────────────────────────────────────────
// 触发源（调度渠道）开关与「上次触发时间」
// 存在 settings 表的两个 key：trigger_sources（JSON 开关）、trigger_seen（JSON 时间戳）
// ─────────────────────────────────────────────────────────────
export async function getTriggerState(env: Env): Promise<{
  sources: Record<TriggerSource, boolean>;
  seen: Partial<Record<TriggerSource, number>>;
}> {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('trigger_sources', 'trigger_seen')",
  ).all();
  let sourcesRaw = '';
  let seenRaw = '';
  for (const r of rows.results ?? []) {
    const k = String((r as Record<string, unknown>).key);
    const v = String((r as Record<string, unknown>).value ?? '');
    if (k === 'trigger_sources') sourcesRaw = v;
    else if (k === 'trigger_seen') seenRaw = v;
  }
  return { sources: parseTriggerSources(sourcesRaw), seen: parseTriggerSeen(seenRaw) };
}

export async function setTriggerSources(env: Env, sources: Record<TriggerSource, boolean>): Promise<void> {
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,datetime('now'))")
    .bind('trigger_sources', JSON.stringify(sources))
    .run();
}

// 记录某渠道本次触发时间（供前端展示「上次触发」与断档判定）。
// seen 由调用方传入（通常来自本次请求已读到的状态），避免读-改-写二次查询：
// 之前这里内部再读一次，既多一次 D1 读，也会在并发触发时互相覆盖。
export async function touchTriggerSource(
  env: Env,
  source: TriggerSource,
  nowSec: number,
  seen?: Partial<Record<TriggerSource, number>>,
): Promise<void> {
  const current = seen ?? (await getTriggerState(env)).seen;
  current[source] = nowSec;
  await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?,?,datetime('now'))")
    .bind('trigger_seen', JSON.stringify(current))
    .run();
}

// 轻量读取监控间隔（分钟）与上次监控时间，用于防抖判断——避免在「应跳过」的触发上
// 还全量 getConfig（读全部 settings + 解密所有账号 AK/SK，浪费 CPU 与 D1 读）。
export async function getMonitorState(env: Env): Promise<{ intervalMinutes: number; lastRun: number }> {
  const rows = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('monitor_interval', 'last_monitor_run')",
  ).all();
  let intervalMinutes = DEFAULT_CONFIG.monitorInterval;
  let lastRun = 0;
  for (const r of rows.results ?? []) {
    const k = String((r as Record<string, unknown>).key);
    const v = String((r as Record<string, unknown>).value ?? '');
    if (k === 'monitor_interval') intervalMinutes = clampInt(v, 1, 1440, DEFAULT_CONFIG.monitorInterval);
    else if (k === 'last_monitor_run') lastRun = clampInt(v, 0, Number.MAX_SAFE_INTEGER, 0);
  }
  return { intervalMinutes, lastRun };
}

// 只取单个 setting 的值。日志接口等场景只需要一个字段，走全量 getConfig 会读整张 settings
// 并对所有账号凭据做 AES 解密，纯属浪费。
export async function getSetting(env: Env, key: string, fallback = ''): Promise<string> {
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
    const v = (row as Record<string, unknown> | null)?.value;
    return v === undefined || v === null ? fallback : String(v);
  } catch {
    return fallback;
  }
}

export async function getConfig(env: Env): Promise<Config> {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
  const map = new Map<string, string>();
  for (const r of rows.results ?? []) {
    map.set(String(r.key), String(r.value));
  }
  const cfg: Config = structuredClone(DEFAULT_CONFIG);
  cfg.adminPasswordHash = map.get('admin_password_hash') ?? '';
  // 兜底值统一与 DEFAULT_CONFIG 一致：仅在 map 有值时覆盖，否则保留 structuredClone 的默认值。
  // 此前写死 '95'/'KeepCharging'/false/false 与 DEFAULT_CONFIG(90/StopCharging/true/true) 冲突，
  // 在 ensureSchema 默认键写入失败或旧库缺键时会静默回退到错误默认值。
  cfg.trafficThreshold = map.has('traffic_threshold')
    ? clampInt(map.get('traffic_threshold'), 1, 100, DEFAULT_CONFIG.trafficThreshold)
    : DEFAULT_CONFIG.trafficThreshold;
  cfg.shutdownMode = map.get('shutdown_mode') || DEFAULT_CONFIG.shutdownMode;
  cfg.thresholdAction = map.get('threshold_action') || DEFAULT_CONFIG.thresholdAction;
  cfg.apiInterval = map.has('api_interval')
    ? clampInt(map.get('api_interval'), 60, 86400, DEFAULT_CONFIG.apiInterval)
    : DEFAULT_CONFIG.apiInterval;
  cfg.monitorInterval = map.has('monitor_interval')
    ? clampInt(map.get('monitor_interval'), 1, 1440, DEFAULT_CONFIG.monitorInterval)
    : DEFAULT_CONFIG.monitorInterval;
  cfg.timezone = map.get('timezone') || DEFAULT_CONFIG.timezone;
  cfg.keepAlive = map.has('keep_alive') ? map.get('keep_alive') === '1' : DEFAULT_CONFIG.keepAlive;
  cfg.enableBilling = map.has('enable_billing') ? map.get('enable_billing') === '1' : DEFAULT_CONFIG.enableBilling;
  cfg.enableScheduleMail = map.get('enable_schedule_mail') === '1';
  cfg.enableStatusChangeNotify = map.has('enable_status_change_notify')
    ? map.get('enable_status_change_notify') === '1'
    : DEFAULT_CONFIG.enableStatusChangeNotify;
  cfg.logRetentionDays = map.has('log_retention_days')
    ? clampInt(map.get('log_retention_days'), 1, 365, DEFAULT_CONFIG.logRetentionDays)
    : DEFAULT_CONFIG.logRetentionDays;
  // 通知配置从 JSON 字段读取：与默认值逐通道深合并。
  // 旧版本写入的配置可能缺少新通道键（smtp/serverchan/pushplus/template），
  // 整体替换会让下游 `n.smtp.password` 之类访问抛 TypeError，导致接口 500。
  const notifRaw = map.get('notifications');
  if (notifRaw) {
    try {
      const stored = JSON.parse(notifRaw) as Record<string, unknown>;
      // 敏感字段（telegram token / smtp password / webhook secret 等）解密回明文，
      // 供下游 deliverEvent 投递。旧库明文值经 decrypt 原样透传，平滑兼容。
      const decrypted = await decryptNotifyConfig(env, stored);
      const merged: Record<string, unknown> = {};
      for (const [chan, def] of Object.entries(cfg.notifications)) {
        const cur = decrypted[chan];
        merged[chan] = cur && typeof cur === 'object'
          ? { ...(def as Record<string, unknown>), ...(cur as Record<string, unknown>) }
          : def;
      }
      // 兼容最早的三通道版本：email → smtp（字段名不同，按需映射）
      const legacy = decrypted.email as Record<string, unknown> | undefined;
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
  // keepAlive 未显式指定时默认开启：账号级保活是「全局开关之上的收窄」，默认跟随全局。
  // 之前前端不提交该字段，统一被写成 0，导致账号级开关形同虚设。
  const keepAlive = account.keepAlive === undefined ? true : account.keepAlive;
  if (account.id) {
    await env.DB.prepare(
      `UPDATE accounts SET name=?, remark=?, region_id=?, instance_id=?, access_key_id_enc=?, access_key_secret_enc=?, site_type=?, max_traffic=?, start_time=?, stop_time=?, schedule_enabled=?, keep_alive=?, shutdown_mode=?, updated_at=? WHERE id=?`,
    ).bind(
      name, remark, account.regionId, instanceId,
      akEnc, skEnc, account.siteType, account.maxTraffic, startTime, stopTime,
      account.scheduleEnabled ? 1 : 0, keepAlive ? 1 : 0, account.shutdownMode ?? '',
      // 统一用带 Z 后缀的 ISO：datetime('now') 写入的是 UTC 无后缀字符串，前端 new Date
      // 会按浏览器本地时区解析，东八区恰好差 8 小时（账号卡片「更新 15:30」实为 23:30）
      new Date().toISOString(), account.id,
    ).run();
    return account.id;
  }
  const result = await env.DB.prepare(
    `INSERT INTO accounts (name, remark, region_id, instance_id, access_key_id_enc, access_key_secret_enc, site_type, max_traffic, start_time, stop_time, schedule_enabled, keep_alive, shutdown_mode, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    name, remark, account.regionId, instanceId,
    akEnc, skEnc, account.siteType, account.maxTraffic, startTime, stopTime,
    account.scheduleEnabled ? 1 : 0, keepAlive ? 1 : 0, account.shutdownMode ?? '',
    new Date().toISOString(),
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
  // keep_alive 列此前在 UPDATE 里遗漏（saveAccount 有它），导致编辑已有账号时
  // 「账号级保活」开关关不掉——UI 提示保存成功但列值不变。现已补上。
  // 语义：与 AK/SK 一致，仅在调用方显式传入时才写该列。若用「未传则默认 true」，
  // API 客户端只发 {id:1, remark:"x"} 改备注时会把已关闭的账号级保活又打开成 1。
  const hasKeepAlive = a.keepAlive !== undefined;
  const sql =
    `UPDATE accounts SET name=?, remark=?, region_id=?, instance_id=?, site_type=?, max_traffic=?, schedule_enabled=?, start_time=?, stop_time=?, shutdown_mode=?` +
    (hasKeepAlive ? ', keep_alive=?' : '') +
    (akEnc ? ', access_key_id_enc=?' : '') +
    (skEnc ? ', access_key_secret_enc=?' : '') +
    // updated_at 与 updateRuntime 一致用带 Z 的 ISO；datetime('now') 是 UTC 无后缀，
    // 前端按本地时区解析会差 8 小时（东八区「更新 15:30」实为 23:30 的成因之一）
    `, updated_at=? WHERE id=?`;
  const vals: unknown[] = [
    name, remark, a.regionId ?? '', a.instanceId ?? '', a.siteType ?? 'china',
    a.maxTraffic ?? 0, a.scheduleEnabled ? 1 : 0, a.startTime ?? '', a.stopTime ?? '', a.shutdownMode ?? '',
  ];
  if (hasKeepAlive) vals.push(a.keepAlive ? 1 : 0);
  if (akEnc) vals.push(akEnc);
  if (skEnc) vals.push(skEnc);
  // updated_at 排在全部动态列之后，与 SQL 拼接顺序一致
  vals.push(new Date().toISOString());
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

// 一次监控刷新后的「状态落库 + 流量采样」合并成一个 batch 写入。
// D1 的 DB.batch() 只计 1 个 subrequest，而分开写 updateRuntime + addTrafficStat 是 2 个；
// 每账号每轮省 1 个，5 账号 × 288 轮/天 ≈ 省 1440 个/天，是压到 Free 计划 50 上限内的关键杠杆。
// 语义不变：两条语句互不依赖，合并后原子性反而更强。
export async function writeRuntimeBatch(
  env: Env,
  id: number,
  traffic: number,
  status: string,
  updatedAt: string,
  recordStat: boolean,
  recordedAt: string,
): Promise<void> {
  const stmts = [
    env.DB.prepare(
      'UPDATE accounts SET traffic_used=?, instance_status=?, updated_at=? WHERE id=?',
    ).bind(traffic, status, updatedAt, id),
  ];
  if (recordStat) {
    stmts.push(
      env.DB.prepare('INSERT INTO traffic_stats (account_id, traffic, recorded_at) VALUES (?,?,?)')
        .bind(id, traffic, recordedAt),
    );
  }
  await env.DB.batch(stmts);
}

export async function history(env: Env, accountId: number): Promise<{ traffic: number; recorded_at: string }[]> {
  const rows = await env.DB.prepare(
    'SELECT traffic, recorded_at FROM traffic_stats WHERE account_id = ? ORDER BY recorded_at DESC LIMIT 720',
  ).bind(accountId).all();
  return (rows.results ?? []) as { traffic: number; recorded_at: string }[];
}

export async function addLog(env: Env, type: string, message: string): Promise<void> {
  // created_at 显式写带 Z 的 UTC ISO，不依赖表默认值：线上已有的 logs 表是早期
  // ensureSchema 建的（CREATE IF NOT EXISTS 不会更新默认值），其实际默认值与当前
  // schema 可能不同——已观察到存成了本地时间字符串，导致日志时间在两种"差 8 小时"
  // 之间反复。写入端统一后，前端只需一套解析规则。
  await env.DB.prepare('INSERT INTO logs (type, message, created_at) VALUES (?,?,?)')
    .bind(type, message, new Date().toISOString()).run();
}

// 业务分类 → 底层日志类型集合（登录/监控/保活/告警，其余归「全部」）
const LOG_CATEGORY_TYPES: Record<string, string[]> = {
  auth: ['audit'],
  monitor: ['heartbeat', 'info'],
  keepalive: ['keepalive'],
  alert: ['warning', 'error'],
  // DNS 轮换解析：解析切换成功记 'ddns'，失败记 'error'（归入告警分类）
  ddns: ['ddns'],
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

  // COUNT 上限截断：日志保留 30 天时会有数万行，全表 COUNT 没有索引下界可利用，
  // 每次翻页都实算一次纯属浪费。超过 COUNT_CAP 就按"已有足够多"返回，前端翻页到上限即可。
  // 注意 COUNT_CAP 不能太大：日志页前端每 10 秒自动刷新一次，5 个管理员同时开着页面，
  // 每分钟就是 30 次全量 COUNT 扫描，直接撞 D1 免费 5M 行/天读取配额。10000 已经够展示
  // 「总页数」的观感，也把单次扫描行数压到可控范围。
  const COUNT_CAP = 10000;
  const totalRow = await env.DB.prepare(
    'SELECT COUNT(*) AS c FROM (SELECT 1 FROM logs ' + where + ' LIMIT ' + COUNT_CAP + ')',
  ).bind(...params).first();
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
// D1 的 datetime('now') 为 UTC，created_at 也是 datetime('now') 写入的 UTC 时间，可直接比较。
// 注意：不能写 datetime('now','-? days') —— ? 在单引号字符串字面量内不会被当绑定参数，
// 会得到 NULL 导致恒 false（删 0 行）。这里用字符串拼接把天数参数化。
export async function cleanupExpiredLogs(env: Env, retentionDays: number): Promise<number> {
  const days = Math.max(1, Math.floor(retentionDays));
  const result = await env.DB.prepare(
    "DELETE FROM logs WHERE created_at < datetime('now', '-' || ? || ' days')",
  ).bind(String(days)).run();
  // 返回实际删除量。绝大多数 D1 版本对 DELETE 的 meta.changes 是准确的；
  // 个别版本恒为 0 也只会让调用方看到"删了 0 条"，不影响正确性（清理本身是幂等的）。
  return result?.meta?.changes ?? 0;
}

// 清理其他「只增不删」的辅助表，避免长期无限增长逼近 D1 存储上限。
// 各表时间字段格式不同，需分别处理：
//   - traffic_stats.recorded_at 为 ISO 字符串（now.toISOString()），用 ISO 阈值比较
//   - action_events.created_at / login_attempts.created_at 为 datetime('now') UTC，用 SQL 修饰符
//   - sessions 按 expires_at（ISO）清理已过期会话 + created_at 兜底
// 全部幂等、失败互不影响；保留天数与日志一致（logRetentionDays）。
export async function cleanupExpiredData(env: Env, retentionDays: number): Promise<void> {
  const days = Math.max(1, Math.floor(retentionDays));

  // traffic_stats：ISO 格式，阈值日期 = N 天前的 ISO 字符串
  const isoThreshold = new Date(Date.now() - days * 86400 * 1000).toISOString();
  await env.DB.prepare('DELETE FROM traffic_stats WHERE recorded_at < ?').bind(isoThreshold).run();

  // action_events：datetime('now') UTC 格式
  await env.DB.prepare(
    "DELETE FROM action_events WHERE created_at < datetime('now', '-' || ? || ' days')",
  ).bind(String(days)).run();

  // login_attempts：datetime('now') UTC 格式
  await env.DB.prepare(
    "DELETE FROM login_attempts WHERE created_at < datetime('now', '-' || ? || ' days')",
  ).bind(String(days)).run();

  // sessions：清掉已过期会话（expires_at 为 ISO）+ 长期未更新的僵尸会话兜底
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(new Date().toISOString()).run();
  await env.DB.prepare(
    "DELETE FROM sessions WHERE created_at < datetime('now', '-' || ? || ' days')",
  ).bind(String(days)).run();
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
  // 直接 INSERT OR IGNORE，用 meta.changes 判胜负：省掉原来"先 SELECT 再 INSERT"的一次读，
  // 且唯一键冲突仍由数据库兜底，语义不变（高并发下不会重复占位）。
  try {
    const res = await env.DB.prepare(
      'INSERT OR IGNORE INTO action_events (key, account_id, type, state, detail) VALUES (?,?,?,?,?)',
    ).bind(key, accountId, type, state, detail).run();
    return (res?.meta?.changes ?? 0) > 0;
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

// 一次查询取回某账号的多个账单缓存 kind（如 balance + instance_bill），
// 替代逐个 billingCache() 调用：D1 的 SELECT ... WHERE kind IN (...) 只算 1 个 subrequest，
// 而 balance（cycle=''）与 instance_bill（cycle='YYYY-MM'）分开查是 2 个。
// 每账号每轮省 1 个，5 账号 × 288 轮/天 ≈ 省 1440 个/天（详见第二轮审查 P0-R2）。
// cycleFor：每个 kind 各自的 cycle（balance 固定 ''，instance_bill 为 'YYYY-MM'），
// 因为两种 kind 的账期维度不同，不能用同一个 cycle 去匹配。
// 返回每个 kind 的 TTL 命中情况（{ hit, value }），供调用方决定是否要重拉阿里云。
export async function billingSnapshot<T>(
  env: Env,
  accountId: number,
  cycleFor: Record<string, string>,
  ttlHours: number,
): Promise<Record<string, { hit: boolean; value?: T }>> {
  const kinds = Object.keys(cycleFor);
  const placeholders = kinds.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT kind, cycle, value, updated_at FROM billing_cache WHERE account_id = ? AND kind IN (${placeholders})`,
  ).bind(accountId, ...kinds).all();

  const nowMs = Date.now();
  const out: Record<string, { hit: boolean; value?: T }> = {};
  for (const k of kinds) out[k] = { hit: false };
  for (const r of rows.results ?? []) {
    const row = r as Record<string, unknown>;
    const kind = String(row.kind);
    // cycle 必须与该 kind 的期望值精确匹配（balance 是 ''，instance_bill 是 'YYYY-MM'）
    if (String(row.cycle ?? '') !== (cycleFor[kind] ?? '')) continue;
    // TTL 判断：D1 的 datetime('now') 返回 UTC 无时区字符串，需按 UTC 解析（东八区会差 8 小时）
    const raw = String(row.updated_at ?? '');
    const utcMs = Date.parse(raw.replace(' ', 'T') + 'Z');
    const updatedMs = isNaN(utcMs) ? Date.parse(raw) : utcMs;
    if (nowMs - updatedMs > ttlHours * 3600 * 1000) continue; // 过期视为未命中
    try {
      out[kind] = { hit: true, value: JSON.parse(String(row.value)) as T };
    } catch { out[kind] = { hit: false }; }
  }
  return out;
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

// ---------- API Keys ----------
// 说明：明文 token 只在创建时返回一次，库中只存 tokenHash（与会话 token 同一哈希口径）。
export interface ApiKeyRow {
  id: number;
  name: string;
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

export async function listApiKeys(env: Env): Promise<ApiKeyRow[]> {
  const rows = await env.DB.prepare(
    'SELECT id, name, scopes, created_at, last_used_at, expires_at FROM api_keys ORDER BY id DESC',
  ).all();
  return (rows.results ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    let scopes: string[] = [];
    try { scopes = JSON.parse(String(row.scopes || '[]')); } catch { /* empty */ }
    return {
      id: Number(row.id),
      name: String(row.name ?? ''),
      scopes,
      created_at: String(row.created_at ?? ''),
      last_used_at: row.last_used_at ? String(row.last_used_at) : null,
      expires_at: row.expires_at ? String(row.expires_at) : null,
    };
  });
}

// 返回明文 token（仅此一次）；调用方必须立即展示给用户
export async function createApiKey(
  env: Env,
  name: string,
  scopes: string[],
  expiresAt: string | null,
  tokenPlain: string,
  tokenHashValue: string,
): Promise<number> {
  const res = await env.DB.prepare(
    'INSERT INTO api_keys (name, token_hash, scopes, expires_at) VALUES (?,?,?,?)',
  ).bind(name, tokenHashValue, JSON.stringify(scopes), expiresAt).run();
  return Number(res?.meta?.last_row_id ?? 0);
}

export async function deleteApiKey(env: Env, id: number): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM api_keys WHERE id = ?').bind(id).run();
  return (res?.meta?.changes ?? 0) > 0;
}

// 命中鉴权时刷新 last_used_at；写失败不影响请求（仅用于展示，不做重试）
export async function touchApiKey(env: Env, hash: string): Promise<void> {
  try {
    await env.DB.prepare('UPDATE api_keys SET last_used_at = datetime(\'now\') WHERE token_hash = ?').bind(hash).run();
  } catch { /* 忽略 */ }
}
