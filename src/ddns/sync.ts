// DDNS 同步主流程：算出每组的值班机器 → 把该组所有域名解析切到它的 IP
//
// 省额度的关键：幂等。只有「目标 IP 和厂商当前值不一致」时才调用厂商写接口，
// 厂商查询接口也只在本地记录的 current_ip 对不上时才打。
// 按天轮转的分组一天最多切一次，window 模式一天切几次，量都很小。

import type { Env } from '../security/security';
import * as store from './store';
import { pickActiveMachine, previewRotate, type DdnsMachine, type PickResult } from './scheduler';
import { getProvider } from './providers';
import { fullDomain } from './providers/types';

export interface SyncOptions {
  /** 强制同步：忽略本地 current_ip，重新查厂商并按需写入 */
  force?: boolean;
  /** 只同步指定分组（前端「立即同步」用） */
  groupId?: number;
  /** 是否手动触发（仅用于日志文案区分） */
  manual?: boolean;
}

export interface SyncOutcome {
  groups: number;
  records: number;
  changed: number;
  failed: number;
  skipped: number;
  details: string[];
}

/** 把成员行转成排班算法需要的机器结构 */
function toSchedulerMachines(members: store.DdnsMember[]): DdnsMachine[] {
  return members.map((m) => ({
    id: m.machineId,
    name: m.name,
    ip: m.ip,
    // 停用机器不参与排班：这里直接过滤掉，等同于「临时摘除」
    enabled: m.machineEnabled,
    sortOrder: m.sortOrder,
    days: m.days,
    windowStart: m.windowStart,
    windowEnd: m.windowEnd,
  }));
}

/**
 * 执行一轮 DDNS 同步。
 * 由监控周期尾部调用（runMonitorCycle），也可由前端「立即同步」按钮调用。
 * 返回统计与明细，供日志与接口响应使用。
 */
export async function runDdnsSync(env: Env, opts: SyncOptions = {}): Promise<SyncOutcome> {
  const out: SyncOutcome = { groups: 0, records: 0, changed: 0, failed: 0, skipped: 0, details: [] };

  let groups: store.DdnsGroupDetail[];
  try {
    groups = await store.listGroups(env);
  } catch (err) {
    // 表还没建好（首次部署）或查询异常：记一条日志就返回，不能拖垮监控主流程
    await addDdnsLog(env, 'error', '读取 DDNS 分组失败：' + (err as Error).message).catch(() => {});
    return out;
  }

  const targets = opts.groupId ? groups.filter((g) => g.id === opts.groupId) : groups;
  for (const group of targets) {
    if (!group.enabled) { out.skipped++; continue; }
    if (group.members.length === 0 || group.records.length === 0) {
      out.skipped++;
      continue;
    }
    out.groups++;

    // ① 选值班机器
    const picked: PickResult = pickActiveMachine(
      group.mode,
      toSchedulerMachines(group.members),
      Date.now(),
      group.timezone || 'Asia/Shanghai',
      { anchorDate: group.anchor_date, switchTime: group.switch_time, anchorAt: group.anchor_at },
    );

    // ② 没人值班时走兜底 IP；兜底也为空则保持现状（避免把解析写坏）
    let targetIp = picked.machine?.ip || '';
    let why = picked.reason;
    if (!targetIp) {
      if (group.fallback_ip) {
        targetIp = group.fallback_ip;
        why = `${picked.reason}，已回落到兜底 IP ${targetIp}`;
      } else {
        out.skipped++;
        await addDdnsLog(env, 'warning', `分组「${group.name}」当前无值班机器且未配置兜底 IP，保持原解析不变（${picked.reason}）`).catch(() => {});
        continue;
      }
    }

    // ③ 同步该组下所有启用记录
    for (const rec of group.records) {
      if (!rec.enabled) { out.skipped++; continue; }
      out.records++;
      const provider = getProvider(rec.provider);
      if (!provider) {
        out.failed++;
        out.details.push(`${fullDomain(rec.zone, rec.host)}：未知的 DNS 厂商 ${rec.provider}`);
        await store.markSynced(env, rec.id, rec.current_ip, rec.zone_id, rec.record_id, '未知厂商').catch(() => {});
        continue;
      }

      // 本地记录已一致且非强制 → 直接跳过（省 1~2 次厂商 API）
      if (!opts.force && rec.current_ip && rec.current_ip === targetIp) {
        out.skipped++;
        continue;
      }

      const cred = await store.readCredential(env, rec);
      const target = {
        zone: rec.zone, host: rec.host, ttl: rec.ttl,
        zoneId: rec.zone_id || undefined, recordId: rec.record_id || undefined,
      };

      try {
        // 先查厂商实际值：可能已被外部改动，避免多余的写
        const cur = await provider.query(target, cred);
        if (cur.ip === targetIp) {
          // 厂商已是目标值，只需把本地状态对齐（含回填 zone_id/record_id 供下次快速更新）
          await store.markSynced(env, rec.id, targetIp, cur.zoneId || rec.zone_id, cur.recordId || rec.record_id, '');
          out.skipped++;
          continue;
        }
        await provider.update(target, cred, targetIp);
        await store.markSynced(env, rec.id, targetIp, cur.zoneId || rec.zone_id, cur.recordId || rec.record_id, '');
        out.changed++;
        const msg = `分组「${group.name}」${fullDomain(rec.zone, rec.host)} 解析切换：`
          + `${cur.ip || '(空)'} → ${targetIp}（${picked.machine ? picked.machine.name : '兜底'}；${why}）`;
        out.details.push(msg);
        await addDdnsLog(env, 'ddns', msg).catch(() => {});
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        out.failed++;
        const msg = `分组「${group.name}」${fullDomain(rec.zone, rec.host)} 同步失败：${errMsg}`;
        out.details.push(msg);
        await store.markSynced(env, rec.id, rec.current_ip, rec.zone_id, rec.record_id, errMsg.slice(0, 300)).catch(() => {});
        await addDdnsLog(env, 'error', msg).catch(() => {});
      }
    }
  }

  if (opts.manual && out.details.length === 0) {
    out.details.push('所有分组的解析均已是目标值，无需变更');
  }
  return out;
}

/** 预览未来若干天排班（前端「预览」用） */
export async function previewGroups(env: Env, groupId: number, days: number) {
  const group = await store.getGroup(env, groupId);
  if (!group) return null;
  if (group.mode === 'rotate' || group.mode === 'interval') {
    return previewRotate(
      toSchedulerMachines(group.members),
      Date.now(), days, group.timezone || 'Asia/Shanghai',
      { anchorDate: group.anchor_date, switchTime: group.switch_time, anchorAt: group.anchor_at },
      group.mode,
    );
  }
  // window / static：时段模式不随日期变化，返回当天命中结果即可
  const picked = pickActiveMachine(
    group.mode, toSchedulerMachines(group.members), Date.now(),
    group.timezone || 'Asia/Shanghai',
    { anchorDate: group.anchor_date, switchTime: group.switch_time, anchorAt: group.anchor_at },
  );
  return [{ date: '当前', machineName: picked.machine?.name || '(无)', ip: picked.machine?.ip || '' }];
}

/** DNS 轮换日志：统一走 logs 表，type 用 'ddns' 便于前端筛选 */
async function addDdnsLog(env: Env, type: string, message: string): Promise<void> {
  const { addLog } = await import('../store/store');
  await addLog(env, type, message);
}
