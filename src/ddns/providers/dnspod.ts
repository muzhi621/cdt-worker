// 腾讯云 DNSPod 适配
// API：https://dnspod.tencentcloudapi.com/（版本 2021-03-23，全部走 POST + JSON body）
// 鉴权：TC3-HMAC-SHA256 —— 密钥先按 date → service → tc3_request 三级派生，再对 StringToSign 加签。
//
// 两个最容易签错的地方：
//   1. CanonicalRequest 里的 payload 哈希必须与最终发出的 body 逐字节一致，
//      所以下面只 stringify 一次，同一份字符串既用于哈希也用于 body；
//   2. credentialScope 里的 date 必须是 X-TC-Timestamp 对应的 UTC 日期，
//      跨天那一刻两者不一致会直接被判签名过期。
//
// 与阿里云同理：腾讯的业务错误放在 200 响应体的 Response.Error 里，必须单独检查。
import {
  DnsProvider, DnsProviderError, DnsTarget, hmacSha256Hex, hmacSha256Raw,
  normalizeHost, QueryResult, requestJson, sha256Hex,
} from './types';

const HOST = 'dnspod.tencentcloudapi.com';
const BASE = `https://${HOST}/`;
const SERVICE = 'dnspod';
const VERSION = '2021-03-23';

/** DNSPod 的根域名同样是 '@'，区分于其它厂商的留空/全域名 */
function subdomainOf(target: DnsTarget): string {
  return normalizeHost(target.host);
}

function readCred(cred: Record<string, string>): { secretId: string; secretKey: string } {
  const secretId = String(cred.secret_id || '').trim();
  const secretKey = String(cred.secret_key || '').trim();
  if (!secretId || !secretKey) throw new DnsProviderError('dnspod', '缺少 SecretId 或 SecretKey');
  return { secretId, secretKey };
}

/**
 * 发起一次 TC3 签名的 POST 请求，成功时返回 Response 内容体。
 * @param payload 业务参数对象（不是字符串，序列化在本函数内完成）
 */
async function call(
  action: string,
  payload: Record<string, unknown>,
  secretId: string,
  secretKey: string,
): Promise<any> {
  const timestamp = Math.floor(Date.now() / 1000);
  // 必须按 UTC 取日期，且一定来自上面那个 timestamp，避免跨天时与时间戳错开
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);

  // X-TC-Action 走独立 header，但要注意它不参与签名，真正参与的是 CanonicalRequest 里的 path 与 body
  const canonicalHeaders = `content-type:application/json\nhost:${HOST}\n`;
  const signedHeaders = 'content-type;host';
  const canonicalRequest = [
    'POST', '/', '', canonicalHeaders, signedHeaders, await sha256Hex(body),
  ].join('\n');

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    'TC3-HMAC-SHA256', String(timestamp), credentialScope, await sha256Hex(canonicalRequest),
  ].join('\n');

  // 派生密钥：每一级的 key 都是上一级的原始字节，而不是十六进制字符串
  const enc = new TextEncoder();
  const kDate = await hmacSha256Raw(enc.encode(`TC3${secretKey}`), date);
  const kService = await hmacSha256Raw(kDate, SERVICE);
  const kSigning = await hmacSha256Raw(kService, 'tc3_request');
  const signature = await hmacSha256Hex(kSigning, stringToSign);

  const authorization = [
    'TC3-HMAC-SHA256',
    `Credential=${secretId}/${credentialScope},`,
    `SignedHeaders=${signedHeaders},`,
    `Signature=${signature}`,
  ].join(' ');

  const data = await requestJson(BASE, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/json',
      Host: HOST,
      'X-TC-Action': action,
      'X-TC-Version': VERSION,
      'X-TC-Timestamp': String(timestamp),
    },
    body,
  });

  const err = data?.Response?.Error;
  if (err) throw new DnsProviderError('dnspod', `${err.Code}：${err.Message || '未知错误'}`);
  return data?.Response;
}

export const dnspodProvider: DnsProvider = {
  meta: {
    id: 'dnspod',
    label: '腾讯云 DNSPod',
    fields: [
      { key: 'secret_id', label: 'SecretId', placeholder: 'AKID...', hint: '腾讯云控制台 → 访问管理 → 访问密钥' },
      {
        key: 'secret_key', label: 'SecretKey', secret: true,
        placeholder: 'SecretKey', hint: '建议为 CAM 子账号只授予 QcloudDNSPodFullAccess',
      },
    ],
    minTtl: 60,
    hint: 'DNSPod 最小 TTL 为 60 秒；需先在控制台存在一条对应主机记录的 A 记录',
  },

  async query(target: DnsTarget, cred: Record<string, string>): Promise<QueryResult> {
    const { secretId, secretKey } = readCred(cred);
    const res = await call(
      'DescribeRecordList',
      { Domain: target.zone, Subdomain: subdomainOf(target) },
      secretId, secretKey,
    );
    const rec = (res?.RecordList || []).find((r: any) => r?.Type === 'A');
    if (!rec) return { ip: '', recordId: '' }; // 记录不存在：本期不自动创建，update 会给出明确提示
    return { ip: String(rec.Value || ''), recordId: String(rec.RecordId || '') };
  },

  async update(target: DnsTarget, cred: Record<string, string>, ip: string): Promise<void> {
    const { secretId, secretKey } = readCred(cred);
    const recordId = String(target.recordId || '').trim();
    if (!recordId) {
      // 接口的查询需要记录 ID，而创建接口还要处理线路（RecordLine）等复杂参数，本期不自动创建，
      // 与其静默失败不如此处明确报错，让用户先在控制台建好 A 记录
      throw new DnsProviderError(
        'dnspod',
        `未找到 ${target.zone} 的主机记录记录 ID，请先在 DNSPod 控制台创建对应的 A 记录后再启用同步`,
      );
    }
    await call(
      'ModifyRecord',
      {
        Domain: target.zone,
        Subdomain: subdomainOf(target),
        RecordId: Number(recordId),
        RecordType: 'A',
        RecordLine: '默认',
        Value: ip,
        TTL: target.ttl || 60,
      },
      secretId, secretKey,
    );
  },
};
