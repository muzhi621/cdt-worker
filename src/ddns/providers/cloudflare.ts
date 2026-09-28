// Cloudflare DNS 适配（参考实现）
// API：https://api.cloudflare.com/client/v4
// 鉴权：Authorization: Bearer <api_token>（权限需含 Zone → DNS → Edit）
import {
  DnsProvider, DnsProviderError, DnsTarget, fullDomain, normalizeHost, QueryResult, requestJson,
} from './types';

const BASE = 'https://api.cloudflare.com/client/v4';

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/** 取 zone_id：优先用已回填的，否则按 zone 名查 */
async function resolveZoneId(zone: string, token: string): Promise<string> {
  const data = await requestJson(`${BASE}/zones?name=${encodeURIComponent(zone)}`, {
    headers: authHeaders(token),
  });
  const hit = (data?.result || []).find((z: any) => z?.name === zone) || data?.result?.[0];
  if (!hit?.id) throw new DnsProviderError('cloudflare', `未找到域名 ${zone} 对应的 Zone，请确认 API Token 有该域名的权限`);
  return String(hit.id);
}

export const cloudflareProvider: DnsProvider = {
  meta: {
    id: 'cloudflare',
    label: 'Cloudflare',
    fields: [
      { key: 'api_token', label: 'API Token', secret: true, placeholder: 'Zone → DNS → Edit 权限的 Token', hint: '在 Cloudflare 控制台「我的个人资料 → API 令牌」创建' },
    ],
    minTtl: 60,
    hint: '开启橙云代理时 TTL 会被强制为 auto，解析切换几乎立即生效',
  },

  async query(target: DnsTarget, cred: Record<string, string>): Promise<QueryResult> {
    const token = String(cred.api_token || '').trim();
    if (!token) throw new DnsProviderError('cloudflare', '缺少 API Token');

    const zoneId = target.zoneId || await resolveZoneId(target.zone, token);
    const name = fullDomain(target.zone, target.host);

    // 已知 record_id 时按 ID 直接取，省一次列表查询
    if (target.recordId) {
      try {
        const one = await requestJson(`${BASE}/zones/${zoneId}/dns_records/${target.recordId}`, {
          headers: authHeaders(token),
        });
        const r = one?.result;
        if (r?.content) return { ip: String(r.content), zoneId, recordId: String(r.id || target.recordId) };
      } catch { /* 记录可能被删除，回退到按名字查 */ }
    }

    const data = await requestJson(
      `${BASE}/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`,
      { headers: authHeaders(token) },
    );
    const rec = (data?.result || [])[0];
    if (!rec) return { ip: '', zoneId, recordId: '' }; // 记录不存在，交由 update 创建
    return { ip: String(rec.content || ''), zoneId, recordId: String(rec.id || '') };
  },

  async update(target: DnsTarget, cred: Record<string, string>, ip: string): Promise<void> {
    const token = String(cred.api_token || '').trim();
    if (!token) throw new DnsProviderError('cloudflare', '缺少 API Token');

    const zoneId = target.zoneId || await resolveZoneId(target.zone, token);
    const name = fullDomain(target.zone, target.host);
    const body = { type: 'A', name, content: ip, ttl: target.ttl || 60, proxied: false };

    if (target.recordId) {
      await requestJson(`${BASE}/zones/${zoneId}/dns_records/${target.recordId}`, {
        method: 'PUT', headers: authHeaders(token), body: JSON.stringify(body),
      });
      return;
    }
    // 记录不存在：先按名字找一次，有则更新、无则创建
    const list = await requestJson(
      `${BASE}/zones/${zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`,
      { headers: authHeaders(token) },
    );
    const exist = (list?.result || [])[0];
    if (exist?.id) {
      await requestJson(`${BASE}/zones/${zoneId}/dns_records/${exist.id}`, {
        method: 'PUT', headers: authHeaders(token), body: JSON.stringify(body),
      });
      return;
    }
    await requestJson(`${BASE}/zones/${zoneId}/dns_records`, {
      method: 'POST', headers: authHeaders(token), body: JSON.stringify(body),
    });
  },
};

// 导出以保持一致（normalizeHost 供其他 provider 复用语义）
export { normalizeHost };
