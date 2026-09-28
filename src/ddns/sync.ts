// DDNS 同步主流程：算出每组的值班机器 → 把该组所有域名解析切到它的 IP
//
// 省额度的关键：幂等。只有「目标 IP 和厂商当前值不一致」时才调用厂商写接口，
// 厂商查询接口也只在本地记录的 current_ip 对不上时才打。
// 按天轮转的分组一天最多切一次，window 模式一天切几次，量都很小。

import type { Env } from '../security/security';
import * as store from './store';
// P3-R4-1：这里的 store 是「DDNS 自己的 store」（src/ddns/store.ts，它并没有 addLog），
// 写日志要用根目录的 src/store/store.ts。显式命名为 rootStore，避免两个 store 混淆。
import * as rootStore from '../store/store';
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

/**
 * 切换时刻突发护栏：本轮 DDNS 同步允许消耗的 subrequest 上限。
 *
 * 推导链 —— 改动监控预算时必须同步改这里：
 *   50  Cloudflare Free 计划「单次请求」subrequest 上限
 *   − 35  监控周期峰值（runDdnsSync 与监控跑在同一 invocation 内，见 server.ts:1211）
 *   − 5   安全余量（周期日志 / 过期清理等固定开销）
 *   = 10
 *
 * 统计口径：厂商 fetch（query / update）**与 D1 读、D1 写一样计入** 50 上限。
 * 上一版只数 fetch 并把上限拍成 20，结果 35 + 20 = 55 已经越线，
 * 护栏反而成了一张「合法的越线许可证」（第四轮审查 P0-R4-1）。
 *
 * 注意：稳态下目标 IP 与厂商一致会提前跳过（本文件幂等设计），绝大多数轮次 0 厂商调用；
 * 护栏只在切换时刻真正生效，宁可晚几分钟切换也不拖垮监控。
 */
export const DDNS_SUBREQUEST_BUDGET = 10;

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
  // P0-R4-1：本轮已消耗的 subrequest 估算。厂商 fetch 与 D1 读/写**都计数**，
  // 二者同样计入 Cloudflare 的 50 上限（上一版只数 fetch，漏掉了大半开销）。
  let spent = 0;
  let budgetHit = false;
  // P1-R4-2：凭据本地缓存。同一分组的多条记录通常共用同一凭据，逐条 readCredential
  // 会各付一次 D1 读 + 一次 AES-GCM 解密（CPU 10 ms 是崩溃线）。
  // 只在本次同步内有效，随函数返回即回收，不存在 isolate 长活泄漏问题。
  const credCache = new Map<string, Record<string, string>>();
  // P2-R4-3：成功切换的明细先累积，循环结束后合成一条日志；
  // 失败仍逐条写（要能定位到具体域名），成功的合并写，避免切换时刻灌屏 + 省 D1 写。
  const changedMsgs: string[] = [];

  /** 本轮 subrequest 是否已触顶 */
  const overBudget = (): boolean => spent >= DDNS_SUBREQUEST_BUDGET;
  /** 首次触顶时记一条警告，重复触顶不再刷屏 */
  const noteBudgetHit = async (): Promise<void> => {
    if (budgetHit) return;
    budgetHit = true;
    await addDdnsLog(env, 'warning',
      `DDNS 同步已达本轮 subrequest 上限（${DDNS_SUBREQUEST_BUDGET}），剩余切换将在下一轮监控周期续做`).catch(() => {});
  };

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
        spent++; // markSynced = 1 次 D1 写（同样计入 50 上限）
        await store.markSynced(env, rec.id, rec.current_ip, rec.zone_id, rec.record_id, '未知厂商').catch(() => {});
        continue;
      }

      // 本地记录已一致且非强制 → 直接跳过（省 1~2 次厂商 API）
      if (!opts.force && rec.current_ip && rec.current_ip === targetIp) {
        out.skipped++;
        continue;
      }

      // P0-R4-1：本轮已消耗额度触顶 → 停止回填、下轮续做（避免触发 CF 1101 中断监控）
      if (overBudget()) {
        out.skipped++;
        await noteBudgetHit();
        continue;
      }

      // P1-R4-2：凭据按「凭据标识」缓存，命中即免掉一次 D1 读 + 一次 AES-GCM 解密
      const credKey = `${rec.credential_id || 0}:${rec.credential_enc || ''}`;
      let cred = credCache.get(credKey);
      if (!cred) {
        spent++; // readCredential 内含 1 次 D1 读
        cred = await store.readCredential(env, rec);
        credCache.set(credKey, cred);
      }
      const target = {
        zone: rec.zone, host: rec.host, ttl: rec.ttl,
        zoneId: rec.zone_id || undefined, recordId: rec.record_id || undefined,
      };

      try {
        // 先查厂商实际值：可能已被外部改动，避免多余的写
        spent++; // provider.query = 1 次厂商 fetch
        const cur = await provider.query(target, cred);
        if (cur.ip === targetIp) {
          // 厂商已是目标值，只需把本地状态对齐（含回填 zone_id/record_id 供下次快速更新）
          spent++; // markSynced = 1 次 D1 写
          await store.markSynced(env, rec.id, targetIp, cur.zoneId || rec.zone_id, cur.recordId || rec.record_id, '');
          out.skipped++;
          continue;
        }
        // 需要写入：再次检查护栏（update 是另一个 subrequest）
        if (overBudget()) {
          out.skipped++;
          await noteBudgetHit();
          continue;
        }
        spent++; // provider.update = 1 次厂商 fetch
        await provider.update(target, cred, targetIp);
        spent++; // markSynced = 1 次 D1 写
        await store.markSynced(env, rec.id, targetIp, cur.zoneId || rec.zone_id, cur.recordId || rec.record_id, '');
        out.changed++;
        const msg = `分组「${group.name}」${fullDomain(rec.zone, rec.host)} 解析切换：`
          + `${cur.ip || '(空)'} → ${targetIp}（${picked.machine ? picked.machine.name : '兜底'}；${why}）`;
        out.details.push(msg);
        changedMsgs.push(msg); // P2-R4-3：不逐条写日志，循环结束后合成一条
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        out.failed++;
        const msg = `分组「${group.name}」${fullDomain(rec.zone, rec.host)} 同步失败：${errMsg}`;
        out.details.push(msg);
        spent += 2; // markSynced(D1 写) + addDdnsLog(D1 写)
        await store.markSynced(env, rec.id, rec.current_ip, rec.zone_id, rec.record_id, errMsg.slice(0, 300)).catch(() => {});
        await addDdnsLog(env, 'error', msg).catch(() => {});
      }
    }
  }

  // P2-R4-3：成功切换合成一条日志（失败已在上面逐条记录——那里需要定位到具体域名）。
  // 切换时刻可能多组多记录同时变更，逐条写会灌满日志页并多付一堆 D1 写。
  if (changedMsgs.length > 0) {
    spent++;
    const shown = changedMsgs.slice(0, 8);
    const more = changedMsgs.length > shown.length ? ` …等共 ${changedMsgs.length} 条` : '';
    await addDdnsLog(env, 'ddns', `DDNS 解析切换 ${changedMsgs.length} 条：${shown.join('；')}${more}`).catch(() => {});
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
  await rootStore.addLog(env, type, message);
}
