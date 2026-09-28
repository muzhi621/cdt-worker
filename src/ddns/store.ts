// DDNS 数据访问层：分组 / 机器 / 成员 / 解析记录的读写
//
// 与 src/store/store.ts 平级但独立成文件，避免把监控账号与 DDNS 两套业务
// 揉进同一个巨型模块（二者数据模型无关，只共享同一个 D1 与加密工具）。
//
// 凭据一律 AES-GCM 加密后落库（复用 security.ts 的 encrypt/decrypt），
// 明文永不落盘；读取时解密成 Record<string,string> 交给 provider。

import { decrypt, encrypt, type Env } from '../security/security';

export type DdnsMode = 'rotate' | 'interval' | 'window' | 'static';

export interface DdnsGroupRow {
  id: number;
  name: string;
  mode: string;
  timezone: string;
  switch_time: string;
  anchor_date: string;
  anchor_at: string;
  fallback_ip: string;
  enabled: number;
}

export interface DdnsGroup extends Omit<DdnsGroupRow, 'enabled'> {
  enabled: boolean;
}

export interface DdnsMachineRow {
  id: number;
  name: string;
  ip: string;
  remark: string;
  enabled: number;
}

export interface DdnsMachine {
  id: number;
  name: string;
  ip: string;
  remark: string;
  enabled: boolean;
}

export interface DdnsMemberInput {
  machineId: number;
  days: number;
  windowStart: string;
  windowEnd: string;
  sortOrder: number;
}

/** 成员 + 机器信息（排班计算需要 ip） */
export interface DdnsMember extends DdnsMemberInput {
  name: string;
  ip: string;
  machineEnabled: boolean;
}

export interface DdnsRecordRow {
  id: number;
  group_id: number;
  provider: string;
  zone: string;
  host: string;
  ttl: number;
  zone_id: string;
  record_id: string;
  credential_id: number;
  credential_enc: string;
  current_ip: string;
  enabled: number;
  last_sync_at: string | null;
  last_error: string;
}

/** DNS 厂商凭据（独立实体，可被多条解析记录复用） */
export interface DdnsCredentialRow {
  id: number;
  name: string;
  provider: string;
  credential_enc: string;
}

export interface DdnsCredential {
  id: number;
  name: string;
  provider: string;
  /** 凭据字段是否已填写（前端用来显示「已填字段」） */
  filled: boolean;
}

/** 凭据 + 脱敏值（overview 给前端展示用，不回明文/密文） */
export interface DdnsCredentialDetail extends DdnsCredential {
  masked: Record<string, string>;
}

export interface DdnsRecord extends Omit<DdnsRecordRow, 'enabled'> {
  enabled: boolean;
}

/** 分组 + 成员 + 记录（同步与前端总览都用它） */
export interface DdnsGroupDetail extends DdnsGroup {
  members: DdnsMember[];
  records: DdnsRecord[];
}

function toGroup(r: DdnsGroupRow): DdnsGroup {
  return {
    id: r.id, name: r.name, mode: r.mode, timezone: r.timezone,
    switch_time: r.switch_time, anchor_date: r.anchor_date, anchor_at: r.anchor_at || '',
    fallback_ip: r.fallback_ip, enabled: !!r.enabled,
  };
}

function toMachine(r: DdnsMachineRow): DdnsMachine {
  return { id: r.id, name: r.name, ip: r.ip, remark: r.remark, enabled: !!r.enabled };
}

function toRecord(r: DdnsRecordRow): DdnsRecord {
  return {
    id: r.id, group_id: r.group_id, provider: r.provider, zone: r.zone, host: r.host,
    ttl: r.ttl, zone_id: r.zone_id, record_id: r.record_id,
    credential_id: Number(r.credential_id || 0),
    credential_enc: r.credential_enc, current_ip: r.current_ip,
    enabled: !!r.enabled, last_sync_at: r.last_sync_at, last_error: r.last_error,
  };
}

/* ------------------------------ 机器 ------------------------------ */

export async function listMachines(env: Env): Promise<DdnsMachine[]> {
  const res = await env.DB.prepare(
    'SELECT id, name, ip, remark, enabled FROM ddns_machines ORDER BY id ASC',
  ).all();
  return ((res.results || []) as unknown as DdnsMachineRow[]).map(toMachine);
}

export async function createMachine(
  env: Env, name: string, ip: string, remark: string, enabled: boolean,
): Promise<number> {
  const res = await env.DB.prepare(
    'INSERT INTO ddns_machines (name, ip, remark, enabled) VALUES (?,?,?,?)',
  ).bind(name, ip, remark, enabled ? 1 : 0).run();
  return Number(res.meta?.last_row_id ?? 0);
}

export async function updateMachine(
  env: Env, id: number, name: string, ip: string, remark: string, enabled: boolean,
): Promise<void> {
  await env.DB.prepare(
    'UPDATE ddns_machines SET name=?, ip=?, remark=?, enabled=?, updated_at=datetime(\'now\') WHERE id=?',
  ).bind(name, ip, remark, enabled ? 1 : 0, id).run();
}

export async function deleteMachine(env: Env, id: number): Promise<void> {
  // 成员关系靠外键级联删除；这里再显式删一次，防止旧库外键未生效留下脏数据
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ddns_group_members WHERE machine_id=?').bind(id),
    env.DB.prepare('DELETE FROM ddns_machines WHERE id=?').bind(id),
  ]);
}

/* ------------------------------ 分组 ------------------------------ */

export async function listGroups(env: Env): Promise<DdnsGroupDetail[]> {
  const groups = ((await env.DB.prepare('SELECT * FROM ddns_groups ORDER BY id ASC').all())
    .results || []) as unknown as DdnsGroupRow[];
  const out: DdnsGroupDetail[] = [];
  for (const g of groups) {
    out.push({
      ...toGroup(g),
      members: await listMembers(env, g.id),
      records: await listRecords(env, g.id),
    });
  }
  return out;
}

export async function getGroup(env: Env, id: number): Promise<DdnsGroupDetail | null> {
  const row = await env.DB.prepare('SELECT * FROM ddns_groups WHERE id=?').bind(id).first();
  if (!row) return null;
  const g = row as unknown as DdnsGroupRow;
  return {
    ...toGroup(g),
    members: await listMembers(env, id),
    records: await listRecords(env, id),
  };
}

/**
 * 读取成员（JOIN 机器表拿到 ip）。
 * 只取启用机器——停用机器不参与排班，但记录仍保留，便于重新启用。
 */
async function listMembers(env: Env, groupId: number): Promise<DdnsMember[]> {
  const res = await env.DB.prepare(
    `SELECT m.machine_id, m.days, m.window_start, m.window_end, m.sort_order,
            mch.name, mch.ip, mch.enabled AS machine_enabled
     FROM ddns_group_members m
     JOIN ddns_machines mch ON mch.id = m.machine_id
     WHERE m.group_id = ?
     ORDER BY m.sort_order ASC, m.machine_id ASC`,
  ).bind(groupId).all();
  return ((res.results || []) as unknown as {
    machine_id: number; days: number; window_start: string; window_end: string;
    sort_order: number; name: string; ip: string; machine_enabled: number;
  }[]).map((r) => ({
    machineId: r.machine_id,
    days: r.days,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    sortOrder: r.sort_order,
    name: r.name,
    ip: r.ip,
    machineEnabled: !!r.machine_enabled,
  }));
}

export async function createGroup(env: Env, g: {
  name: string; mode: string; timezone: string; switchTime: string;
  anchorDate: string; anchorAt: string; fallbackIp: string; enabled: boolean;
}): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO ddns_groups (name, mode, timezone, switch_time, anchor_date, anchor_at, fallback_ip, enabled)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(g.name, g.mode, g.timezone, g.switchTime, g.anchorDate, g.anchorAt || '', g.fallbackIp, g.enabled ? 1 : 0).run();
  return Number(res.meta?.last_row_id ?? 0);
}

export async function updateGroup(env: Env, id: number, g: {
  name: string; mode: string; timezone: string; switchTime: string;
  anchorDate: string; anchorAt: string; fallbackIp: string; enabled: boolean;
}): Promise<void> {
  await env.DB.prepare(
    `UPDATE ddns_groups SET name=?, mode=?, timezone=?, switch_time=?, anchor_date=?, anchor_at=?,
     fallback_ip=?, enabled=?, updated_at=datetime('now') WHERE id=?`,
  ).bind(g.name, g.mode, g.timezone, g.switchTime, g.anchorDate, g.anchorAt || '', g.fallbackIp, g.enabled ? 1 : 0, id).run();
}

export async function deleteGroup(env: Env, id: number): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM ddns_group_members WHERE group_id=?').bind(id),
    env.DB.prepare('DELETE FROM ddns_records WHERE group_id=?').bind(id),
    env.DB.prepare('DELETE FROM ddns_groups WHERE id=?').bind(id),
  ]);
}

/** 全量保存成员：先清后插（成员通常只有几台，全量替换比 diff 简单且不易出错） */
export async function saveMembers(env: Env, groupId: number, members: DdnsMemberInput[]): Promise<void> {
  const stmts = [env.DB.prepare('DELETE FROM ddns_group_members WHERE group_id=?').bind(groupId)];
  for (const m of members) {
    stmts.push(env.DB.prepare(
      `INSERT INTO ddns_group_members (group_id, machine_id, days, window_start, window_end, sort_order)
       VALUES (?,?,?,?,?,?)`,
    ).bind(groupId, m.machineId, Math.max(1, m.days), m.windowStart, m.windowEnd, m.sortOrder));
  }
  // batch 只算 1 个 subrequest，成员再多也只有一次往返
  await env.DB.batch(stmts);
}

/* ------------------------------ 解析记录 ------------------------------ */

export async function listRecords(env: Env, groupId?: number): Promise<DdnsRecord[]> {
  const res = groupId
    ? await env.DB.prepare('SELECT * FROM ddns_records WHERE group_id=? ORDER BY id ASC').bind(groupId).all()
    : await env.DB.prepare('SELECT * FROM ddns_records ORDER BY id ASC').all();
  return ((res.results || []) as unknown as DdnsRecordRow[]).map(toRecord);
}

export async function createRecord(env: Env, r: {
  groupId: number; provider: string; zone: string; host: string; ttl: number;
  credentialId: number; enabled: boolean;
}): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO ddns_records (group_id, provider, zone, host, ttl, credential_id, enabled)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(r.groupId, r.provider, r.zone, r.host || '@', r.ttl, Number(r.credentialId) || 0, r.enabled ? 1 : 0).run();
  return Number(res.meta?.last_row_id ?? 0);
}

export async function updateRecord(env: Env, id: number, patch: {
  provider?: string; zone?: string; host?: string; ttl?: number;
  credentialId?: number; enabled?: boolean;
}): Promise<void> {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (patch.provider !== undefined) { sets.push('provider=?'); vals.push(patch.provider); }
  if (patch.zone !== undefined) { sets.push('zone=?'); vals.push(patch.zone); }
  if (patch.host !== undefined) { sets.push('host=?'); vals.push(patch.host || '@'); }
  if (patch.ttl !== undefined) { sets.push('ttl=?'); vals.push(patch.ttl); }
  if (patch.enabled !== undefined) { sets.push('enabled=?'); vals.push(patch.enabled ? 1 : 0); }
  if (patch.credentialId !== undefined) {
    sets.push('credential_id=?');
    vals.push(Number(patch.credentialId) || 0);
  }
  if (sets.length === 0) return;
  sets.push('updated_at=datetime(\'now\')');
  vals.push(id);
  await env.DB.prepare(`UPDATE ddns_records SET ${sets.join(',')} WHERE id=?`).bind(...vals).run();
}

export async function deleteRecord(env: Env, id: number): Promise<void> {
  await env.DB.prepare('DELETE FROM ddns_records WHERE id=?').bind(id).run();
}

/** 同步结果回写：当前 IP / 厂商侧 ID / 错误信息 */
export async function markSynced(
  env: Env, id: number, ip: string, zoneId: string, recordId: string, error: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE ddns_records SET current_ip=?, zone_id=?, record_id=?, last_error=?,
     last_sync_at=datetime('now'), updated_at=datetime('now') WHERE id=?`,
  ).bind(ip, zoneId, recordId, error, id).run();
}

/** 解密一段凭据密文：损坏时返回空对象而非抛出，避免一条脏凭据打断整轮同步 */
async function decryptCredential(env: Env, enc: string): Promise<Record<string, string>> {
  try {
    const plain = await decrypt(env, enc || '');
    const parsed = JSON.parse(plain || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

/**
 * 读取某条解析记录实际使用的凭据（明文）。
 * 优先按 credential_id 引用独立凭据；未绑定则回退到历史遗留的内嵌密文 credential_enc。
 */
export async function readCredential(env: Env, row: DdnsRecord): Promise<Record<string, string>> {
  const cid = Number(row.credential_id || 0);
  if (cid > 0) {
    const enc = await getCredentialEnc(env, cid);
    if (enc !== null) return decryptCredential(env, enc);
  }
  return decryptCredential(env, row.credential_enc || '');
}

/* ------------------------------ DNS 凭据 ------------------------------ */

/** 取凭据密文（内部用）；不存在返回 null */
async function getCredentialEnc(env: Env, id: number): Promise<string | null> {
  const row = await env.DB.prepare('SELECT credential_enc FROM ddns_credentials WHERE id=?').bind(id).first();
  if (!row) return null;
  return String((row as { credential_enc?: string }).credential_enc || '');
}

/** 凭据列表（含脱敏值与「是否已填写」标记），供 overview 与凭据页展示 */
export async function listCredentials(env: Env): Promise<DdnsCredentialDetail[]> {
  const res = await env.DB.prepare(
    'SELECT id, name, provider, credential_enc FROM ddns_credentials ORDER BY id ASC',
  ).all();
  const rows = (res.results || []) as unknown as DdnsCredentialRow[];
  const out: DdnsCredentialDetail[] = [];
  for (const r of rows) {
    const cred = await decryptCredential(env, r.credential_enc);
    out.push({
      id: r.id, name: r.name, provider: r.provider,
      filled: Object.keys(cred).length > 0,
      masked: maskCredential(cred),
    });
  }
  return out;
}

/** 按 id 取凭据行（含厂商，供连通测试用）；不存在返回 null */
export async function getCredential(env: Env, id: number): Promise<DdnsCredentialRow | null> {
  const row = await env.DB.prepare(
    'SELECT id, name, provider, credential_enc FROM ddns_credentials WHERE id=?',
  ).bind(id).first();
  return row ? (row as unknown as DdnsCredentialRow) : null;
}

/** 按 id 解密凭据明文（连通测试用） */
export async function readCredentialById(env: Env, id: number): Promise<Record<string, string>> {
  const enc = await getCredentialEnc(env, id);
  return enc === null ? {} : decryptCredential(env, enc);
}

/** 取第一条引用该凭据的解析记录（连通测试缺省 zone/host 时用） */
export async function firstRecordUsingCredential(env: Env, id: number): Promise<DdnsRecord | null> {
  const row = await env.DB.prepare(
    'SELECT * FROM ddns_records WHERE credential_id=? ORDER BY id ASC LIMIT 1',
  ).bind(id).first();
  return row ? toRecord(row as unknown as DdnsRecordRow) : null;
}

export async function createCredential(env: Env, c: {
  name: string; provider: string; credential: Record<string, string>;
}): Promise<number> {
  const enc = await encrypt(env, JSON.stringify(c.credential || {}));
  const res = await env.DB.prepare(
    'INSERT INTO ddns_credentials (name, provider, credential_enc) VALUES (?,?,?)',
  ).bind(c.name, c.provider, enc).run();
  return Number(res.meta?.last_row_id ?? 0);
}

/** 更新凭据；credential 为 undefined 时保留原密文（只改名称/厂商） */
export async function updateCredential(env: Env, id: number, patch: {
  name?: string; provider?: string; credential?: Record<string, string>;
}): Promise<void> {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (patch.name !== undefined) { sets.push('name=?'); vals.push(patch.name); }
  if (patch.provider !== undefined) { sets.push('provider=?'); vals.push(patch.provider); }
  if (patch.credential !== undefined) {
    // 合并式更新：前端只提交改动的字段，其余字段保留原值（留空即不修改）
    const existing = await decryptCredential(env, (await getCredentialEnc(env, id)) || '');
    const merged = { ...existing, ...patch.credential };
    sets.push('credential_enc=?');
    vals.push(await encrypt(env, JSON.stringify(merged)));
  }
  if (sets.length === 0) return;
  sets.push('updated_at=datetime(\'now\')');
  vals.push(id);
  await env.DB.prepare(`UPDATE ddns_credentials SET ${sets.join(',')} WHERE id=?`).bind(...vals).run();
}

/** 引用该凭据的解析记录条数（删除前校验用） */
export async function countRecordsUsingCredential(env: Env, id: number): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM ddns_records WHERE credential_id=?',
  ).bind(id).first();
  return Number((row as { n?: number })?.n || 0);
}

export async function deleteCredential(env: Env, id: number): Promise<void> {
  // 解除引用后再删，避免留下悬空 credential_id
  await env.DB.batch([
    env.DB.prepare('UPDATE ddns_records SET credential_id=0 WHERE credential_id=?').bind(id),
    env.DB.prepare('DELETE FROM ddns_credentials WHERE id=?').bind(id),
  ]);
}

/** 读取凭据但不含明文（供前端展示脱敏） */
export function maskCredential(cred: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cred || {})) {
    const s = String(v ?? '');
    out[k] = s.length > 8 ? s.slice(0, 3) + '****' + s.slice(-3) : (s ? '****' : '');
  }
  return out;
}
