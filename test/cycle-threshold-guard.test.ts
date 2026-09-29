// 回归测试：循环开关机的「开机相位」不得把因**流量超限**而停机的实例重新拉起。
//
// 背景（审查发现的 P1）：阈值停机用的幂等键 `threshold:{id}:active` **不带日期**——
// 只要流量仍超限就不会被删除，因此超限后不会重复停机。而实例一旦真正变成 Stopped，
// 循环开机相位会判定「状态偏离目标」并下发开机指令，于是实例被拉起后一路跑到流量
// 自然回落，直接违背「逼近上限自动停机规避超额费用」这一核心目标。
// 修复方式：循环执行块条件加上 `!overThreshold`。本测试锁定该语义，防止被改回去。
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as aliyun from '../src/provider/aliyun';
import * as store from '../src/store/store';
import { processAccount } from '../src/engine/engine';
import { DEFAULT_CONFIG } from '../src/store/store';
import type { Env } from '../src/security/security';
import type { Account } from '../src/provider/aliyun';

// 测试环境没有 Cloudflare 运行时，engine 依赖树里的 cloudflare:sockets 必须桩掉。
vi.mock('cloudflare:sockets', () => ({
  connect: () => { throw new Error('cloudflare:sockets 未在本测试环境实现（桩）'); },
}));

function fakeEnv(): Env {
  return { DB: {} as unknown as Env['DB'], CDT_MASTER_KEY: '' } as unknown as Env;
}

/** 启用「N 天循环」的账号：基准时间设为过去，确保处于已启动的开机相位 */
function cycleAccount(over: boolean): Account {
  // 基准时间取「2 天前」，周期 10 天 → 第 1 相位（开机相位）内
  const d = new Date(Date.now() - 2 * 86400_000);
  const p = (n: number) => String(n).padStart(2, '0');
  const anchor = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 00:00:00`;
  return {
    id: 1,
    name: 'cycle-acct',
    remark: 'cycle-acct',
    regionId: 'cn-hangzhou',
    instanceId: 'i-test',
    accessKeyId: 'LTAI-test',
    accessKeySecret: 'secret',
    siteType: 'china',
    // maxTraffic=100，trafficUsed=95 → 95%（>= 90% 阈值）；未超限时用 10%
    maxTraffic: 100,
    trafficUsed: over ? 95 : 10,
    startTime: '08:00',
    stopTime: '23:00',
    scheduleEnabled: false, // 与循环互斥，此处只启用循环
    cycleEnabled: true,
    cycleAnchor: anchor,
    cycleDays: 10,
    cycleStartOn: true, // 首个相位为开机
    keepAlive: false,
    shutdownMode: '',
    instanceStatus: 'Stopped', // 已停机（超限停机后的状态）
    updatedAt: new Date().toISOString(),
  } as unknown as Account;
}

function baseConfig() {
  return {
    ...DEFAULT_CONFIG,
    timezone: 'UTC',
    trafficThreshold: 90, // 95% 超限 / 10% 未超限
    thresholdAction: 'stop_and_notify',
    enableScheduleMail: false, // 关掉通知，避免依赖 outbox
    enableBilling: false,
    keepAlive: false,
    monitorInterval: 5,
  };
}

afterEach(() => vi.restoreAllMocks());

async function run(over: boolean) {
  const env = fakeEnv();
  const control = vi.spyOn(aliyun, 'controlInstance').mockResolvedValue(undefined as never);
  vi.spyOn(aliyun, 'getTraffic').mockResolvedValue(over ? 95 : 10);
  vi.spyOn(aliyun, 'getInstanceStatus').mockResolvedValue('Stopped');
  vi.spyOn(store, 'addLog').mockResolvedValue(undefined as never);
  vi.spyOn(store, 'writeRuntimeBatch').mockResolvedValue(undefined as never);
  vi.spyOn(store, 'updateRuntime').mockResolvedValue(undefined as never);
  vi.spyOn(store, 'addOutbox').mockResolvedValue(undefined as never);
  // 首次调用视为「未记录过」，让阈值与循环动作都能走到下发分支
  vi.spyOn(store, 'recordActionEvent').mockResolvedValue(true);
  vi.spyOn(store, 'deleteActionEvent').mockResolvedValue(undefined as never);

  const res = await processAccount(env, cycleAccount(over), true, baseConfig() as never);
  return { res, control };
}

describe('循环开机相位 vs 流量超限停机（P1 回归）', () => {
  it('流量未超限时，开机相位会把已停止的实例拉起', async () => {
    const { res, control } = await run(false);
    expect(control).toHaveBeenCalledTimes(1);
    expect(control.mock.calls[0][2]).toBe('start');
    expect(res.actions).toContain('cycle_start');
  });

  it('流量超限时，开机相位不得下发开机指令（避免把止损停机的实例拉回来继续计费）', async () => {
    const { res, control } = await run(true);
    // 关键断言：超限期间一条控制指令都不该发出
    expect(control).not.toHaveBeenCalled();
    expect(res.actions).not.toContain('cycle_start');
    expect(res.actions).not.toContain('cycle_start_fixed');
  });
});
