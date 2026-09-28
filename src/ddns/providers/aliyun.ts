// 阿里云云解析 DNS 适配
// API：https://alidns.aliyuncs.com/（版本 2015-01-09，所有接口走 GET + 查询串）
// 鉴权：POP 签名 v1 —— HMAC-SHA1 作用于「请求方法 + URI + 规范化查询串」，
//       密钥必须是 `${AccessKeySecret}&`（末尾这个 & 是协议规定，漏掉必签错），
//       算出的签名还要再 percentEncode 一次才能作为 Signature 参数值放进 URL。
//
// 踩坑提示：阿里云的业务错误（如 Code: 'InvalidDomainName.NoExist'）是塞在 200 响应体里的，
// HTTP 状态码永远成功，所以每个响应都必须检查 Code 字段，只看状态码等于没做错误处理。
import {
  canonicalize, DnsProvider, DnsProviderError, DnsTarget, hmacSha1Base64,
  normalizeHost, percentEncode, QueryResult, requestJson,
} from './types';

const BASE = 'https://alidns.aliyuncs.com/';
const VERSION = '2015-01-09';

/** 根域名在阿里云里用 '@' 表示，与 Cloudflare 的「完整域名」表述不同 */
function rrOf(target: DnsTarget): string {
  return normalizeHost(target.host);
}

function readCred(cred: Record<string, string>): { ak: string; sk: string } {
  const ak = String(cred.access_key_id || '').trim();
  const sk = String(cred.access_key_secret || '').trim();
  if (!ak || !sk) throw new DnsProviderError('aliyun', '缺少 AccessKey ID 或 AccessKey Secret');
  return { ak, sk };
}

/**
 * 发起一次带签名的 GET 请求。
 * @param biz 业务参数（不含公共参数），公共参数在这里统一补齐
 */
async function call(action: string, biz: Record<string, string>, ak: string, sk: string): Promise<any> {
  const params: Record<string, string> = {
    ...biz,
    Action: action,
    AccessKeyId: ak,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    // 每次请求的随机串，防止重放；放在闭包里生成，避免多处调用复用同一个 nonce
    SignatureNonce: crypto.randomUUID(),
    SignatureType: '',
    SignatureVersion: '1.0',
    // 阿里云只接受 UTC 的 ISO8601 秒级格式，毫秒部分必须去掉
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: VERSION,
  };

  // 签名针对的是「不含 Signature 的参数集」——先算串再补签名字段，顺序反了就自相矛盾
  const canonicalQuery = canonicalize(params);
  // 第二段的 '/' 必须单独 percentEncode，它是被当作值参与的
  const stringToSign = `GET&${percentEncode('/')}&${percentEncode(canonicalQuery)}`;
  const signature = await hmacSha1Base64(`${sk}&`, stringToSign);

  // canonicalize 会对 value 做百分号编码，正好满足 Signature 需要再次编码的要求
  const url = `${BASE}?${canonicalize({ ...params, Signature: signature })}`;
  const data = await requestJson(url);
  if (data?.Code) throw new DnsProviderError('aliyun', `${data.Code}：${data.Message || '未知错误'}`);
  return data;
}

/** 列出域名的全部解析记录（该接口只能一次性返回，RR/Type 需在本地过滤） */
async function listRecords(zone: string, ak: string, sk: string): Promise<any[]> {
  const data = await call('DescribeDomainRecords', { DomainName: zone }, ak, sk);
  return data?.DomainRecords?.Record || [];
}

function findRecord(list: any[], target: DnsTarget): any {
  const rr = rrOf(target);
  return list.find((r: any) => r?.RR === rr && r?.Type === 'A');
}

export const aliyunProvider: DnsProvider = {
  meta: {
    id: 'aliyun',
    label: '阿里云云解析',
    fields: [
      { key: 'access_key_id', label: 'AccessKey ID', placeholder: 'LTAI...', hint: '建议使用只带 AliyunDNSFullAccess 的子账号 AK' },
      {
        key: 'access_key_secret', label: 'AccessKey Secret', secret: true,
        placeholder: 'AccessKey Secret', hint: '阿里云 AccessKey Secret，仅用于签名，不会离开 Worker',
      },
    ],
    minTtl: 600,
    hint: '免费版云解析最小 TTL 为 600 秒，低于该值会被阿里云自动上调',
  },

  async query(target: DnsTarget, cred: Record<string, string>): Promise<QueryResult> {
    const { ak, sk } = readCred(cred);
    const rec = findRecord(await listRecords(target.zone, ak, sk), target);
    if (!rec) return { ip: '', recordId: '' }; // 记录不存在，交给 update 创建
    return { ip: String(rec.Value || ''), recordId: String(rec.RecordId || '') };
  },

  async update(target: DnsTarget, cred: Record<string, string>, ip: string): Promise<void> {
    const { ak, sk } = readCred(cred);
    const rr = rrOf(target);
    // 免费版最小 600，兜底值就用它，防止上层传 60 时被网关拒绝
    const ttl = String(target.ttl || 600);

    let recordId = String(target.recordId || '').trim();
    if (!recordId) {
      // recordId 可能从未回填，或记录被用户在控制台重建过，先按 RR 查一次再决定新增还是更新
      const hit = findRecord(await listRecords(target.zone, ak, sk), target);
      recordId = hit?.RecordId ? String(hit.RecordId) : '';
    }

    if (recordId) {
      await call('UpdateDomainRecord', { RecordId: recordId, RR: rr, Type: 'A', Value: ip, TTL: ttl }, ak, sk);
      return;
    }
    // 更新接口不需要 DomainName，新增接口需要，二者参数集不同不要混用
    await call('AddDomainRecord', { DomainName: target.zone, RR: rr, Type: 'A', Value: ip, TTL: ttl }, ak, sk);
  },
};
