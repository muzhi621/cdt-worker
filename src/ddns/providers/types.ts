// DNS 服务商适配层：统一接口 + 共用 HTTP/签名工具
//
// 各厂商的字段与签名方式差异极大，这里统一收敛成三个动作：
//   meta（声明需要哪些凭据字段） / query（查当前解析值） / update（写新解析值）
// 上层 sync 只面向本文件定义的接口编程，不感知厂商细节。
//
// 目标记录用「zone + host」而非「完整域名」表示：
//   zone = 注册域（example.com / example.co.uk），host = 主机记录（www / @ / sub）
// 这样能避开「www.example.com.cn 该按几段切」的歧义，也让 @ 根域名表达自然。

/** 凭据字段声明（驱动前端动态渲染表单） */
export interface ProviderField {
  key: string;
  label: string;
  /** 密钥类字段：前端用 password 输入框，展示时脱敏 */
  secret?: boolean;
  placeholder?: string;
  hint?: string;
}

export interface DnsProviderMeta {
  id: string;
  label: string;
  fields: ProviderField[];
  /** 该厂商支持的最小 TTL（秒），用于前端提示 */
  minTtl?: number;
  hint?: string;
}

/** 一条待同步的解析记录 */
export interface DnsTarget {
  /** 注册域，如 example.com */
  zone: string;
  /** 主机记录：@ 表示根域名，www 表示 www.example.com */
  host: string;
  ttl: number;
  /** 厂商侧的区域 ID（Cloudflare/GoDaddy 等需要，首次查询后回填） */
  zoneId?: string;
  /** 厂商侧的记录 ID（首次查询后回填，下次直接更新免查询） */
  recordId?: string;
}

export interface QueryResult {
  /** 当前解析到的 IP；空串表示记录不存在 */
  ip: string;
  zoneId?: string;
  recordId?: string;
}

export interface DnsProvider {
  meta: DnsProviderMeta;
  query(target: DnsTarget, cred: Record<string, string>): Promise<QueryResult>;
  update(target: DnsTarget, cred: Record<string, string>, ip: string): Promise<void>;
}

/** 厂商 API 返回的业务错误：带可读文案，直接进日志 */
export class DnsProviderError extends Error {
  constructor(public provider: string, message: string) {
    super(`[${provider}] ${message}`);
    this.name = 'DnsProviderError';
  }
}

const DEFAULT_TIMEOUT_MS = 15000;

/** 统一 JSON 请求：带超时、统一抛可读错误，避免各 provider 各写一套 */
export async function requestJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<any> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`请求失败（${url.split('?')[0]}）：${msg}`);
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const detail = data?.message || data?.error || data?.errors?.[0]?.message || text.slice(0, 200);
    throw new Error(`HTTP ${res.status}：${detail}`);
  }
  return data;
}

/** HMAC-SHA1 → Base64（阿里云云解析签名用） */
export async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

/** HMAC-SHA256 → 十六进制（腾讯云 TC3 签名用） */
export async function hmacSha256Hex(key: Uint8Array | string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const raw = typeof key === 'string' ? enc.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    'raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256 → 原始字节（TC3 派生密钥需要链式 HMAC） */
export async function hmacSha256Raw(key: Uint8Array, data: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return new Uint8Array(sig);
}

/** SHA-256 → 十六进制 */
export async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 阿里云风格的参数规范化（用于签名 stringToSign）。
 * 注意这里必须对 key 和 value 都做 percentEncode 后再排序，顺序错了签名必失败。
 */
export function canonicalize(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&');
}

/** RFC 3986 百分号编码：阿里云要求空格编码成 %20 而不是 + */
export function percentEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/!/g, '%21').replace(/\*/g, '%2A')
    .replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/'/g, '%27');
}

/** host 记录归一化：用户在 UI 填 @ / 留空 / 带尾点，统一成厂商各自的习惯由 provider 自行处理 */
export function normalizeHost(host: string | null | undefined): string {
  const h = String(host ?? '').trim().replace(/\.$/, '');
  return h === '' ? '@' : h;
}

/** 拼出完整域名（展示与日志用） */
export function fullDomain(zone: string, host: string): string {
  const h = normalizeHost(host);
  const z = String(zone ?? '').trim().replace(/\.$/, '');
  return h === '@' ? z : `${h}.${z}`;
}
