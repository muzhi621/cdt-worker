// 阿里云 RPC 签名与 Provider 适配层
// 对应原 Go 项目 internal/aliyun/client.go
// 用 Web Crypto API 实现 HMAC-SHA1 签名，等价于原 sign() 函数

export interface Account {
  id: number;
  name: string; // AccessKeyID（脱敏后展示用）
  remark: string;
  regionId: string;
  instanceId: string;
  accessKeyId: string; // 加密存储
  accessKeySecret: string; // 加密存储
  siteType: 'china' | 'international';
  maxTraffic: number; // GB
  startTime: string; // "HH:mm"
  stopTime: string; // "HH:mm"
  scheduleEnabled: boolean;
  keepAlive: boolean;
  // 账号级停机模式：'' 跟随系统全局设置；'KeepCharging'|'StopCharging' 覆盖全局
  shutdownMode: string;
  instanceStatus: string;
  trafficUsed: number;
  updatedAt: string;
}

export interface BillingBalance {
  amount: number;
  currency: string;
}

export interface BillingBill {
  totalCost: number;
  itemCount?: number; // 账单条目数，便于排查「查不到金额」的原因
}

// RFC 3986 百分号编码：阿里云 ECS 与阿里云 DNS 用的是同一套 POP 签名规范，
// 因此直接复用 DDNS 侧的实现（src/ddns/providers/types.ts），不再各写一份。
//
// P2-8：原 ECS 侧副本只有两条 replace（%7E→~、%2A→*），而 encodeURIComponent
// 本就不会产生 %7E/%2A —— 这两句是**空操作**；真正需要补编码的 ! ' ( ) *
// （RFC 3986 的 sub-delims，阿里云要求编码）却没补，含这些字符的参数会
// SignatureDoesNotMatch。两份实现漂移是这类「偶尔签名失败」的温床，故合并为一处。
//
// 注意：encodeURIComponent 已把空格编为 %20、字面 + 编为 %2B，与规范一致；
// 不能再执行 %2B → %20 的替换（那是 Go 版对 url.QueryEscape「空格编为 +」的补救，
// 照搬到 JS 会把参数里真正的 + 改成空格，导致 SignatureDoesNotMatch）。
import { percentEncode } from '../ddns/providers/types';
export { percentEncode };

// 阿里云调用异常：带 retryable 标记，让上层重试逻辑有明确类型可判
// （原来靠给 Error 实例挂任意属性 + as any 断言，类型不安全且网络错误路径容易漏标）
export class AliyunError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = 'AliyunError';
    this.retryable = retryable;
  }
}

/**
 * P1-2：阿里云调用超时。这是全项目唯一没有超时的出站请求（对照组：通知 8s、
 * DDNS 15s、自建驱动 60s）。「连得上但不回包」会把整个监控周期挂住。
 * 超时抛出的 abort 由下面的 catch 包成 AliyunError(retryable=true)，直接复用已有重试。
 */
const ALIYUN_TIMEOUT_MS = 10_000;

/**
 * P1-3：默认尝试次数 3 → 2。重试 × 分页会放大 subrequest（getInstanceBill 最坏
 * 3 页 × 2 次 = 6，实例级为空时再走账号级 → 12），逼近 Cloudflare 50 上限。
 * 降到 2 后上限减半，代价是偶发 5xx 少一次重试机会 —— 下一轮监控周期仍会覆盖。
 */
const ALIYUN_MAX_ATTEMPTS = 2;

// HMAC 密钥缓存：每个监控周期要签十几次 API，importKey 属毫秒级开销。
// AK Secret 在 isolate 内不变，按 secret 缓存 CryptoKey（最多账号数条，LRU 式清理）。
const hmacKeyCache = new Map<string, CryptoKey>();
const HMAC_KEY_CACHE_MAX = 64;

/** 十六进制 SHA-256 摘要（Web Crypto 属纯 CPU，不产生 subrequest） */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  // P2-7：用 SHA-256 摘要做缓存键，而不是把明文 AK Secret 直接留在 Map 的键里 ——
  // 堆快照 / 调试转储 / 异常上下文都可能顺带把 Map 的键打印出来，那是主密钥级的泄露面。
  const cacheKey = await sha256Hex(secret + '&');
  const cached = hmacKeyCache.get(cacheKey);
  if (cached) {
    // 命中后移到末尾，维持「最久未用排在前面」的 LRU 顺序（Map 按插入顺序迭代）
    hmacKeyCache.delete(cacheKey);
    hmacKeyCache.set(cacheKey, cached);
    return cached;
  }
  const enc = new TextEncoder();
  const imported = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret + '&'),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  // P2-7：原来 size > 64 就 clear() 全清 —— 下一次调用要全部重新 importKey，
  // 且在临界点会反复「填满→清空→填满」抖动。改为只淘汰最久未用的那一条。
  // 实际账号数是常量级，这条分支几乎不会触发，只是防止极端情况下无限增长。
  if (hmacKeyCache.size >= HMAC_KEY_CACHE_MAX) {
    const oldest = hmacKeyCache.keys().next().value;
    if (oldest !== undefined) hmacKeyCache.delete(oldest);
  }
  hmacKeyCache.set(cacheKey, imported);
  return imported;
}

// 阿里云 RPC 签名：HMAC-SHA1，等价原 sign()（导出供单测与 Node crypto 交叉验证）
export async function sign(params: Record<string, string>, secret: string): Promise<string> {
  const keys = Object.keys(params)
    .filter((k) => k !== 'Signature')
    .sort();
  const canonical = keys
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
  const stringToSign = `POST&%2F&${percentEncode(canonical)}`;
  const enc = new TextEncoder();
  const keyData = await getHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', keyData, enc.encode(stringToSign));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function randomNonce(): string {
  const buf = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

// 执行一次阿里云 RPC 调用，等价原 call() + callOnce()
export async function callAliyun(
  accessKeyId: string,
  secret: string,
  region: string,
  host: string,
  version: string,
  action: string,
  extras: Record<string, string> = {},
  retries = ALIYUN_MAX_ATTEMPTS,
): Promise<Record<string, unknown>> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await callOnce(accessKeyId, secret, region, host, version, action, extras);
    } catch (err) {
      lastErr = err as Error;
      // 只有 5xx / 429 / 网络错误才重试（与原逻辑一致）
      const retryable = (err as any)?.retryable === true;
      if (!retryable || attempt === retries - 1) break;
      // P1-3：退避必须带抖动。固定 300/700ms 会让所有账号在同一毫秒集体重试——
      // 而 Throttling.User 恰恰是「多账号同时打」才会触发，无抖动等于把限流风暴
      // 同步放大。加 [0,400)ms 随机量把重试在时间上摊开。
      await new Promise((r) =>
        setTimeout(r, Math.pow(2, attempt) * 300 + attempt * 100 + Math.random() * 400),
      );
    }
  }
  throw lastErr ?? new Error(`aliyun ${action} failed`);
}

async function callOnce(
  accessKeyId: string,
  secret: string,
  region: string,
  host: string,
  version: string,
  action: string,
  extras: Record<string, string>,
): Promise<Record<string, unknown>> {
  const params: Record<string, string> = {
    AccessKeyId: accessKeyId,
    Action: action,
    Format: 'JSON',
    RegionId: region,
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomNonce(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: version,
    ...extras,
  };
  params.Signature = await sign(params, secret);

  const body = new URLSearchParams(params).toString();
  let resp: Response;
  try {
    resp = await fetch(`https://${host}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      // P1-2：必须带超时，否则服务端不回包时会一直挂住整个监控周期
      signal: AbortSignal.timeout(ALIYUN_TIMEOUT_MS),
    });
  } catch (err) {
    // 网络层错误（DNS/TLS/超时）一定可重试，否则会退化成"直接失败"而不是退避重试
    throw new AliyunError(`aliyun ${action} network error: ${err}`, true);
  }

  const text = await resp.text();
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(text);
  } catch {
    throw new AliyunError(`aliyun ${action} invalid response`, resp.status >= 500);
  }

  if (resp.status >= 400) {
    throw new AliyunError(
      `aliyun ${action} http ${resp.status}: ${compactMessage(result, text)}`,
      resp.status >= 500 || resp.status === 429,
    );
  }
  const code = stringValue(result.Code);
  if (code && !isSuccessCode(code)) {
    throw new AliyunError(`aliyun ${action} ${code}: ${stringValue(result.Message)}`,
      code.toLowerCase().includes('throttl'));
  }
  return result;
}

function isSuccessCode(code: string): boolean {
  const c = code.trim().toLowerCase();
  return c === 'ok' || c === '200' || c === 'success';
}

function compactMessage(result: Record<string, unknown>, raw: string): string {
  const m = stringValue(result.Message);
  return m || raw;
}

function trafficClass(region: string): 'china' | 'international' {
  if (region.startsWith('cn-') && region !== 'cn-hongkong') return 'china';
  return 'international';
}

function bssEndpoint(siteType: string): { region: string; host: string } {
  if (siteType === 'international') {
    return { region: 'ap-southeast-1', host: 'business.ap-southeast-1.aliyuncs.com' };
  }
  return { region: 'cn-hangzhou', host: 'business.aliyuncs.com' };
}

function number(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function stringValue(v: unknown): string {
  if (v == null) return '';
  return String(v);
}

function asSlice(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    if (Array.isArray(obj.Item)) return obj.Item;
    if (obj.Item && typeof obj.Item === 'object') return [obj.Item];
  }
  return [];
}

// 查询 CDT 流量，等价 GetTraffic()
export async function getTraffic(account: Account, secret: string): Promise<number> {
  const result = await callAliyun(
    account.accessKeyId,
    secret,
    'cn-hongkong',
    'cdt.aliyuncs.com',
    '2021-08-13',
    'ListCdtInternetTraffic',
  );
  const cls = trafficClass(account.regionId);
  let items = asSlice(result.TrafficDetails);
  if (items.length === 0) {
    const data = result.Data as Record<string, unknown> | undefined;
    if (data) items = asSlice(data.TrafficDetails);
  }
  if (items.length === 0) throw new Error('CDT response has no TrafficDetails');
  let total = 0;
  for (const item of items) {
    const obj = item as Record<string, unknown>;
    const region = stringValue(obj.BusinessRegionId);
    if (trafficClass(region) === cls) total += number(obj.Traffic);
  }
  return total / (1024 * 1024 * 1024);
}

// 查询实例状态，等价 GetInstanceStatus()
export async function getInstanceStatus(account: Account, secret: string): Promise<string> {
  const params: Record<string, string> = { RegionId: account.regionId };
  if (account.instanceId) params.InstanceId = account.instanceId;
  const result = await callAliyun(
    account.accessKeyId,
    secret,
    account.regionId,
    `ecs.${account.regionId}.aliyuncs.com`,
    '2014-05-26',
    'DescribeInstanceStatus',
    params,
  );
  const statuses = asSlice((result.InstanceStatuses as Record<string, unknown>)?.InstanceStatus);
  if (statuses.length === 0) return 'Unknown';
  const first = statuses[0] as Record<string, unknown>;
  const status = stringValue(first.Status);
  return status || 'Unknown';
}

// 控制实例，等价 ControlInstance()
export async function controlInstance(
  account: Account,
  secret: string,
  action: 'start' | 'stop',
  shutdownMode: string,
): Promise<void> {
  if (!account.instanceId) throw new Error('instance_id is required');
  const params: Record<string, string> = {
    RegionId: account.regionId,
    InstanceId: account.instanceId,
  };
  const apiAction = action === 'stop' ? 'StopInstance' : 'StartInstance';
  if (action === 'stop') {
    params.StoppedMode = shutdownMode === 'StopCharging' ? 'StopCharging' : 'KeepCharging';
  }
  await callAliyun(
    account.accessKeyId,
    secret,
    account.regionId,
    `ecs.${account.regionId}.aliyuncs.com`,
    '2014-05-26',
    apiAction,
    params,
  );
}

// 查询账户余额，等价 GetAccountBalance()
export async function getAccountBalance(
  account: Account,
  secret: string,
): Promise<BillingBalance> {
  const bss = bssEndpoint(account.siteType);
  const result = await callAliyun(
    account.accessKeyId,
    secret,
    bss.region,
    bss.host,
    '2017-12-14',
    'QueryAccountBalance',
  );
  const data = result.Data as Record<string, unknown> | undefined;
  const amount = number(data?.AvailableAmount);
  const currency = stringValue(data?.Currency) || 'CNY';
  return { amount, currency };
}

// 查询实例账单，等价 GetInstanceBill()
export async function getInstanceBill(
  account: Account,
  secret: string,
  cycle: string,
  instanceId?: string,
): Promise<BillingBill> {
  const bss = bssEndpoint(account.siteType);
  const targetInstance = instanceId !== undefined ? instanceId : account.instanceId;
  let total = 0;
  let itemCount = 0;
  // 单页拉取（MaxResults 最大 300）。
  // P1-3：原为最多 3 页的分页循环。单实例单月的账单条目远少于 300 条，正常一页就取完；
  // 而每页 × 每次尝试都算 subrequest（3 页 × 2 次 = 6，实例级为空时再走账号级 → 12），
  // 是监控周期里最容易撞 Cloudflare 50 上限的一块。取首页已足以反映本月花费。
  const extras: Record<string, string> = {
    BillingCycle: cycle,
    Granularity: 'MONTHLY',
    MaxResults: '300',
  };
  // InstanceID 为空时不能传空字符串（会被判为非法参数）
  if (targetInstance) extras.InstanceID = targetInstance;

  const result = await callAliyun(
    account.accessKeyId,
    secret,
    bss.region,
    bss.host,
    '2017-12-14',
    'DescribeInstanceBill',
    extras,
  );
  const data = result.Data as Record<string, unknown> | undefined;
  let items = asSlice(data?.Items);
  if (items.length === 0) items = asSlice((data?.Items as Record<string, unknown>)?.Item);
  for (const item of items) {
    const obj = item as Record<string, unknown>;
    total += number(obj.PretaxAmount);
    itemCount++;
  }
  return { totalCost: Math.round(total * 100) / 100, itemCount };
}
