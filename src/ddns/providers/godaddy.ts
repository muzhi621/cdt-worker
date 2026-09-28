// GoDaddy DNS 适配
// API：https://api.godaddy.com/v1
// 鉴权：Authorization: sso-key <api_key>:<api_secret>
//       （注意是 sso-key 前缀，且 Key 与 Secret 之间用冒号连接，不是 Basic Auth）
//
// 两个容易踩的点：
//   1. 读写接口的 body 都是「数组」而不是单条对象 —— PUT 一次会替换该主机记录的全部 A 记录，
//      这正好符合 DDNS 的语义（同一主机只保留一个 IP），所以不需要先删后建；
//   2. 根域名在 URL 路径里用 '@'，且必须原样传：写成空串会被当成路径缺失返回 404；
//   3. 同一主机可以存在多条 A 记录（GoDaddy 支持轮询），query 只认第一条，
//      而 update 的 PUT 会把它们收敛成一条 —— 正好把「多 IP 轮询」切成「单点值班」，符合本项目的预期。
import {
  DnsProvider, DnsProviderError, DnsTarget, normalizeHost, QueryResult, requestJson,
} from './types';

const BASE = 'https://api.godaddy.com/v1';

function readCred(cred: Record<string, string>): { apiKey: string; apiSecret: string } {
  const apiKey = String(cred.api_key || '').trim();
  const apiSecret = String(cred.api_secret || '').trim();
  if (!apiKey) throw new DnsProviderError('godaddy', '缺少 API Key');
  if (!apiSecret) throw new DnsProviderError('godaddy', '缺少 API Secret');
  return { apiKey, apiSecret };
}

function authHeaders(apiKey: string, apiSecret: string): HeadersInit {
  return {
    Authorization: `sso-key ${apiKey}:${apiSecret}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

/**
 * 记录接口路径：/v1/domains/{zone}/records/A/{host}
 * host 只对子域名做百分号编码：'@' 本身是合法的路径字符，且 GoDaddy 要求根域名原样传 '@'，
 * 编码成 %40 后部分网关会当成无效记录名返回 404，因此这里单独放行。
 */
function recordsUrl(zone: string, host: string): string {
  const h = normalizeHost(host);
  const seg = h === '@' ? h : encodeURIComponent(h);
  return `${BASE}/domains/${encodeURIComponent(zone)}/records/A/${seg}`;
}

/**
 * GoDaddy 的错误体是 { code, message, fields }，code 是稳定的机器可读标识，
 * 用它补充人话提示：官方文档只给 code，不看文档很难判断「域名不存在」还是「权限不足」。
 */
function call(url: string, init: RequestInit, zone: string): Promise<any> {
  return requestJson(url, init).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (/HTTP 401|HTTP 403/.test(msg)) {
      throw new DnsProviderError('godaddy', `鉴权失败（${msg}）：请确认使用生产环境（Production）密钥，OTE 密钥与正式域名不互通`);
    }
    if (/HTTP 422|ACCESS_DENIED|UNABLE_TO_AUTHENTICATE/.test(msg)) {
      throw new DnsProviderError('godaddy', `请求被拒绝（${msg}）：常见原因是域名 ${zone} 不属于该账号，或 API Key 权限不足`);
    }
    if (/HTTP 404|DOMAIN_NOT_FOUND/.test(msg)) {
      throw new DnsProviderError('godaddy', `域名不存在（${msg}）：请确认 ${zone} 在该 GoDaddy 账号下`);
    }
    throw new DnsProviderError('godaddy', msg);
  });
}

export const godaddyProvider: DnsProvider = {
  meta: {
    id: 'godaddy',
    label: 'GoDaddy',
    fields: [
      { key: 'api_key', label: 'API Key', secret: true, placeholder: 'API Key', hint: 'developer.godaddy.com → API Keys 创建' },
      { key: 'api_secret', label: 'API Secret', secret: true, placeholder: 'API Secret', hint: '请选择 Production 环境，OTE 环境的密钥无法操作真实域名' },
    ],
    minTtl: 600,
    hint: 'GoDaddy 免费套餐最小 TTL 为 600 秒，切换后生效较慢',
  },

  async query(target: DnsTarget, cred: Record<string, string>): Promise<QueryResult> {
    const { apiKey, apiSecret } = readCred(cred);
    // 响应是数组：有记录时形如 [{ data, ttl, name, type }]，无记录时为空数组而不是错误
    const list = await call(recordsUrl(target.zone, target.host), {
      headers: authHeaders(apiKey, apiSecret),
    }, target.zone);
    const rec = (Array.isArray(list) ? list : [])[0];
    if (!rec) return { ip: '', recordId: '' }; // 记录不存在，交由 update 创建（PUT 自带创建语义）
    // GoDaddy 没有记录级 ID，主机记录 + 类型即可唯一定位，因此 recordId 留空：
    // 上层不必维护 ID，切换 IP 时直接 PUT 同名记录即可
    return { ip: String(rec.data || ''), recordId: '' };
  },

  async update(target: DnsTarget, cred: Record<string, string>, ip: string): Promise<void> {
    const { apiKey, apiSecret } = readCred(cred);
    const host = normalizeHost(target.host);
    // PUT 在这里是「有则替换、无则创建」，所以不需要像 Cloudflare/name.com 那样先查一次再决定 POST 还是 PUT。
    // TTL 直接沿用用户配置：低于账号下限时 GoDaddy 会返回 422，这里不做静默放大，
    // 免得实际生效的 TTL 与界面上看到的不一致
    // body 必须是数组：PUT 会整体替换该主机记录的 A 记录集，传数组才能达到「只留这个 IP」的效果
    const body = JSON.stringify([{ data: ip, ttl: target.ttl || 600, name: host, type: 'A' }]);
    await call(recordsUrl(target.zone, target.host), {
      method: 'PUT',
      headers: authHeaders(apiKey, apiSecret),
      body,
    }, target.zone);
  },
};

// 与其他 provider 保持一致的导出语义
export { normalizeHost };
