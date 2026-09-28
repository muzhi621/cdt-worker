// DDNS 数据访问层：分组 / 机器 / 成员 / 解析记录的读写
//
// 与 src/store/store.ts 平级但独立成文件，避免把监控账号与 DDNS 两套业务
// 揉进同一个巨型模块（二者数据模型无关，只共享同一个 D1 与加密工具）。
//
// 凭据一律 AES-GCM 加密后落库（复用 security.ts 的 encrypt/decrypt），
// 明文永不落盘；读取时解密成 Record<string,string> 交给 provider。

import { decrypt, encrypt, type Env } from '../security/security';

export type DdnsMode = 'rotate' | 'window' | 'static';

export interface DdnsGroupRow {
  id: number;
  name: string;
  mode: string;
  timezone: string;
  switch_time: string;
  anchor_date: string;
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
  credential_enc: string;
  current_ip: string;
  enabled: number;
  last_sync_at: string | null;
  last_error: string;
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
    switch_time: r.switch_time, anchor_date: r.anchor_date,
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
  anchorDate: string; fallbackIp: string; enabled: boolean;
}): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO ddns_groups (name, mode, timezone, switch_time, anchor_date, fallback_ip, enabled)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(g.name, g.mode, g.timezone, g.switchTime, g.anchorDate, g.fallbackIp, g.enabled ? 1 : 0).run();
  return Number(res.meta?.last_row_id ?? 0);
}

export async function updateGroup(env: Env, id: number, g: {
  name: string; mode: string; timezone: string; switchTime: string;
  anchorDate: string; fallbackIp: string; enabled: boolean;
}): Promise<void> {
  await env.DB.prepare(
    `UPDATE ddns_groups SET name=?, mode=?, timezone=?, switch_time=?, anchor_date=?,
     fallback_ip=?, enabled=?, updated_at=datetime('now') WHERE id=?`,
  ).bind(g.name, g.mode, g.timezone, g.switchTime, g.anchorDate, g.fallbackIp, g.enabled ? 1 : 0, id).run();
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
  credential: Record<string, string>; enabled: boolean;
}): Promise<number> {
  const enc = await encrypt(env, JSON.stringify(r.credential || {}));
  const res = await env.DB.prepare(
    `INSERT INTO ddns_records (group_id, provider, zone, host, ttl, credential_enc, enabled)
     VALUES (?,?,?,?,?,?,?)`,
  ).bind(r.groupId, r.provider, r.zone, r.host || '@', r.ttl, enc, r.enabled ? 1 : 0).run();
  return Number(res.meta?.last_row_id ?? 0);
}

export async function updateRecord(env: Env, id: number, patch: {
  provider?: string; zone?: string; host?: string; ttl?: number;
  credential?: Record<string, string>; enabled?: boolean;
}): Promise<void> {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (patch.provider !== undefined) { sets.push('provider=?'); vals.push(patch.provider); }
  if (patch.zone !== undefined) { sets.push('zone=?'); vals.push(patch.zone); }
  if (patch.host !== undefined) { sets.push('host=?'); vals.push(patch.host || '@'); }
  if (patch.ttl !== undefined) { sets.push('ttl=?'); vals.push(patch.ttl); }
  if (patch.enabled !== undefined) { sets.push('enabled=?'); vals.push(patch.enabled ? 1 : 0); }
  if (patch.credential !== undefined) {
    sets.push('credential_enc=?');
    vals.push(await encrypt(env, JSON.stringify(patch.credential)));
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

/** 解密凭据：损坏时返回空对象而非抛出，避免一条脏凭据打断整轮同步 */
export async function readCredential(env: Env, row: DdnsRecord): Promise<Record<string, string>> {
  try {
    const plain = await decrypt(env, row.credential_enc);
    const parsed = JSON.parse(plain || '{}');
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
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
