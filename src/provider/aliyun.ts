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
}

// RFC 3986 百分号编码，等价原 percentEncode()
function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%7E/gi, '~')
    .replace(/%2A/gi, '*')
    .replace(/%2B/gi, '%20');
}

// 阿里云 RPC 签名：HMAC-SHA1，等价原 sign()
async function sign(params: Record<string, string>, secret: string): Promise<string> {
  const keys = Object.keys(params)
    .filter((k) => k !== 'Signature')
    .sort();
  const canonical = keys
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
  const stringToSign = `POST&%2F&${percentEncode(canonical)}`;
  const enc = new TextEncoder();
  const keyData = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret + '&'),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
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
  retries = 3,
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
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 300 + attempt * 100));
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
  const resp = await fetch(`https://${host}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await resp.text();
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(text);
  } catch {
    const err: any = new Error(`aliyun ${action} invalid response`);
    err.retryable = resp.status >= 500;
    throw err;
  }

  if (resp.status >= 400) {
    const err: any = new Error(
      `aliyun ${action} http ${resp.status}: ${compactMessage(result, text)}`,
    );
    err.retryable = resp.status >= 500 || resp.status === 429;
    throw err;
  }
  const code = stringValue(result.Code);
  if (code && !isSuccessCode(code)) {
    const err: any = new Error(`aliyun ${action} ${code}: ${stringValue(result.Message)}`);
    err.retryable = code.toLowerCase().includes('throttl');
    throw err;
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
): Promise<BillingBill> {
  const bss = bssEndpoint(account.siteType);
  const result = await callAliyun(
    account.accessKeyId,
    secret,
    bss.region,
    bss.host,
    '2017-12-14',
    'DescribeInstanceBill',
    { BillingCycle: cycle, InstanceID: account.instanceId, Granularity: 'MONTHLY' },
  );
  const data = result.Data as Record<string, unknown> | undefined;
  let items = asSlice(data?.Items);
  if (items.length === 0) items = asSlice((data?.Items as Record<string, unknown>)?.Item);
  let total = 0;
  for (const item of items) {
    const obj = item as Record<string, unknown>;
    total += number(obj.PretaxAmount);
  }
  return { totalCost: Math.round(total * 100) / 100 };
}
