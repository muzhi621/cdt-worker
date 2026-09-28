// Spaceship DNS 适配
// API：https://spaceship.dev/api/v1
// 鉴权：两个独立请求头 —— X-Api-Key: <api_key>、X-Api-Secret: <api_secret>
//
// 本厂商最大的坑：DNS 记录没有单条增删改接口，更新只能
//   PUT /api/v1/dns/records/{zone}，body 传整组记录 { items: [...] }。
// 该请求会用传入的数组「整体替换」域名的全部解析记录——如果只 PUT 一条 A 记录，
// 用户的 MX / TXT / CNAME 会被静默清空，属于不可逆的破坏性操作。
// 因此 update 必须先 GET 全量记录，在内存里替换（或追加）目标 A 记录，再把完整数组提交回去。
import {
  DnsProvider, DnsProviderError, DnsTarget, normalizeHost, QueryResult, requestJson,
} from './types';

const BASE = 'https://spaceship.dev/api/v1';

function readCred(cred: Record<string, string>): { apiKey: string; apiSecret: string } {
  const apiKey = String(cred.api_key || '').trim();
  const apiSecret = String(cred.api_secret || '').trim();
  if (!apiKey) throw new DnsProviderError('spaceship', '缺少 API Key');
  if (!apiSecret) throw new DnsProviderError('spaceship', '缺少 API Secret');
  return { apiKey, apiSecret };
}

function authHeaders(apiKey: string, apiSecret: string): HeadersInit {
  return {
    'X-Api-Key': apiKey,
    'X-Api-Secret': apiSecret,
    'Content-Type': 'application/json',
  };
}

/** 记录名：不同批次接口可能用 name 或 host，统一取出来并去掉结尾的点 */
function nameOf(item: any): string {
  return String(item?.name ?? item?.host ?? '').trim().replace(/\.$/, '');
}

/** 记录值：A 记录常见字段是 address，也可能退回 value */
function addressOf(item: any): string {
  const raw = item?.address ?? item?.value ?? '';
  return String(raw).trim();
}

/**
 * 主机记录匹配：Spaceship 里根域名出现过三种写法 —— '@'、完整域名、空串，
 * 子域名也可能是 'www' 或 'www.example.com'，这里全部兼容（大小写不敏感）。
 */
function matches(item: any, host: string, zone: string): boolean {
  const want = normalizeHost(host).toLowerCase();
  const name = nameOf(item).toLowerCase();
  const lowerZone = String(zone || '').trim().toLowerCase();
  if (want === '@') return name === '@' || name === '' || name === lowerZone;
  return name === want || name === `${want}.${lowerZone}`;
}

/**
 * 拉取域名下的全部记录。
 * 字段名可能是 items 或 records，做兼容；该接口一次返回全部记录（不分页），
 * 所以拿到的数组可以直接当作「域名当前完整记录集」用于后续整组写回。
 */
async function fetchAll(zone: string, headers: HeadersInit): Promise<any[]> {
  const data = await requestJson(`${BASE}/dns/records/${encodeURIComponent(zone)}`, { headers });
  const list = data?.items || data?.records || [];
  return Array.isArray(list) ? list : [];
}

export const spaceshipProvider: DnsProvider = {
  meta: {
    id: 'spaceship',
    label: 'Spaceship',
    fields: [
      { key: 'api_key', label: 'API Key', secret: true, placeholder: 'API Key', hint: 'Spaceship 控制台 → Settings → API Keys 创建' },
      { key: 'api_secret', label: 'API Secret', secret: true, placeholder: 'API Secret', hint: '创建时只会展示一次，请妥善保存' },
    ],
    minTtl: 60,
    hint: 'Spaceship 更新解析必须整组提交记录，本模块会先读取现有记录再合并写回，不会删除其他记录',
  },

  async query(target: DnsTarget, cred: Record<string, string>): Promise<QueryResult> {
    const { apiKey, apiSecret } = readCred(cred);
    const list = await fetchAll(target.zone, authHeaders(apiKey, apiSecret));
    const rec = list.find((r: any) => String(r?.type || '').toUpperCase() === 'A' && matches(r, target.host, target.zone));
    if (!rec) return { ip: '', recordId: '' }; // 记录不存在，交由 update 追加
    // Spaceship 的写接口按整组记录 PUT，不依赖单条 ID；有则返回以便上层复用
    return { ip: addressOf(rec), recordId: rec?.id ? String(rec.id) : '' };
  },

  async update(target: DnsTarget, cred: Record<string, string>, ip: string): Promise<void> {
    const { apiKey, apiSecret } = readCred(cred);
    const headers = authHeaders(apiKey, apiSecret);
    const url = `${BASE}/dns/records/${encodeURIComponent(target.zone)}`;
    const list = await fetchAll(target.zone, headers);

    const idx = list.findIndex(
      (r: any) => String(r?.type || '').toUpperCase() === 'A' && matches(r, target.host, target.zone),
    );
    const ttl = target.ttl || 60;
    if (idx >= 0) {
      // 原地改字段，保留原记录上的其它键（如 id / 优先级），避免整组写回时丢信息。
      // 写入哪个字段跟随原记录：A 记录一般用 address，个别批次用 value，混用会被接口拒绝
      const item = list[idx];
      if ('address' in item) item.address = ip; else item.value = ip;
      item.ttl = ttl;
    } else {
      // 目标不存在：push 一条新的再整组提交，效果等同于新建，与 query 返回空 recordId 的语义一致
      list.push({ name: normalizeHost(target.host), type: 'A', address: ip, ttl });
    }

    // 注意这里提交的是完整数组（含 MX/TXT/CNAME 等），不能只传目标 A 记录
    await requestJson(url, { method: 'PUT', headers, body: JSON.stringify({ items: list }) });
  },
};

// 与其他 provider 保持一致的导出语义
export { normalizeHost };
