// name.com DNS 适配
// API：https://api.name.com/v4
// 鉴权：HTTP Basic Auth —— Authorization: Basic base64(username + ':' + api_token)
//       Worker 运行时提供 btoa，直接编码即可（用户名/Token 均为 ASCII，无需 UTF-8 预处理）。
//
// 与主流厂商最大的差别是「主机记录」的表达方式：
//   name.com 的根域名 host 是空字符串 ''，而不是常见的 '@'。
//   查询匹配和写入 body 都必须做这个转换，否则根域名永远匹配不上，
//   表现为「查不到 → 每次都新建 → 同域名下堆积重复 A 记录」。
import {
  DnsProvider, DnsProviderError, DnsTarget, fullDomain, normalizeHost, QueryResult, requestJson,
} from './types';

const BASE = 'https://api.name.com/v4';

/** name.com 侧的主机记录：根域名为空串 */
function hostOf(target: DnsTarget): string {
  const h = normalizeHost(target.host);
  return h === '@' ? '' : h;
}

function readCred(cred: Record<string, string>): { username: string; apiToken: string } {
  const username = String(cred.username || '').trim();
  const apiToken = String(cred.api_token || '').trim();
  if (!username) throw new DnsProviderError('namecom', '缺少用户名');
  if (!apiToken) throw new DnsProviderError('namecom', '缺少 API Token');
  return { username, apiToken };
}

function authHeaders(username: string, apiToken: string): HeadersInit {
  return {
    Authorization: `Basic ${btoa(`${username}:${apiToken}`)}`,
    'Content-Type': 'application/json',
  };
}

/**
 * name.com 的业务错误带在响应体的 result.code / result.message 里，
 * HTTP 状态码未必能覆盖全部场景（例如参数不合法可能仍返回 2xx），所以单独检查一次。
 */
function checkBizError(data: any): void {
  const code = Number(data?.result?.code ?? 0);
  const message = String(data?.message || data?.result?.message || '').trim();
  if (code >= 400 && message) throw new DnsProviderError('namecom', `${code}：${message}`);
}

/**
 * 列出域名下的解析记录。
 * name.com 该接口支持分页（perPage / page），默认页容量已足够覆盖常规账号，
 * 且 DDNS 只需要找到目标 A 记录，这里不做翻页以避免额外的请求耗时。
 */
async function listRecords(zone: string, headers: HeadersInit): Promise<any[]> {
  const data = await requestJson(`${BASE}/domains/${encodeURIComponent(zone)}/records`, { headers });
  checkBizError(data);
  return data?.records || [];
}

function findA(records: any[], host: string): any {
  // host 可能为 ''（根域名），统一按字符串比较，避免 undefined 混入
  return records.find((r: any) => r?.type === 'A' && String(r?.host ?? '') === host);
}

export const nameComProvider: DnsProvider = {
  meta: {
    id: 'namecom',
    label: 'name.com',
    fields: [
      { key: 'username', label: '用户名', placeholder: 'name.com 登录用户名', hint: '不是邮箱，是账户名；在 name.com → Profile → API Token 页面可看到' },
      { key: 'api_token', label: 'API Token', secret: true, placeholder: 'API Token', hint: '需在 name.com 后台为该 Token 开启 DNS 读写权限' },
    ],
    minTtl: 300,
    hint: 'name.com 最小 TTL 为 300 秒，根域名主机记录用空字符串表示',
  },

  async query(target: DnsTarget, cred: Record<string, string>): Promise<QueryResult> {
    const { username, apiToken } = readCred(cred);
    const records = await listRecords(target.zone, authHeaders(username, apiToken));
    const rec = findA(records, hostOf(target));
    if (!rec) return { ip: '', recordId: '' }; // 记录不存在，交由 update 创建
    return { ip: String(rec.answer || ''), recordId: String(rec.id || '') };
  },

  async update(target: DnsTarget, cred: Record<string, string>, ip: string): Promise<void> {
    const { username, apiToken } = readCred(cred);
    const headers = authHeaders(username, apiToken);
    const host = hostOf(target);
    // name.com 用 answer 表示记录值，字段名不是常见的 content/value
    const body = JSON.stringify({ host, type: 'A', answer: ip, ttl: target.ttl || 300 });

    let recordId = String(target.recordId || '').trim();
    if (!recordId) {
      // 没有回填 ID：先按名字查一次，有则更新、无则创建
      recordId = String(findA(await listRecords(target.zone, headers), host)?.id || '');
    }
    if (recordId) {
      const data = await requestJson(`${BASE}/domains/${encodeURIComponent(target.zone)}/records/${recordId}`, {
        method: 'PUT', headers, body,
      });
      checkBizError(data);
      return;
    }
    const data = await requestJson(`${BASE}/domains/${encodeURIComponent(target.zone)}/records`, {
      method: 'POST', headers, body,
    });
    checkBizError(data);
    if (!data?.id) {
      throw new DnsProviderError('namecom', `创建 ${fullDomain(target.zone, target.host)} 的 A 记录未返回记录 ID，请到 name.com 后台确认`);
    }
  },
};

// 与其他 provider 保持一致的导出语义
export { normalizeHost };
