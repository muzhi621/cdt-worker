// 回归测试：日志里的账号标识必须带「备注」（accountTag = `备注｜脱敏 AK`）。
//
// 背景（用户报障）：保活日志原本只写脱敏 AccessKeyId（如 `LTAI5tE***`），多账号的 AK 前 7 位
// 相同或极难分辨，于是「保活」标签页里一行行长得一模一样，完全无法判断某条记录属于哪个账号。
// 本测试锁定两点：
//   1) accountTag 的取值与回退链（备注 → 账号名 → 纯脱敏 AK），且**永不泄漏完整 AK**；
//   2) 保活的两条关键日志（跳过原因 / 启动成功）真的用上了该标签。
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as aliyun from '../src/provider/aliyun';
import * as store from '../src/store/store';
import { processAccount, accountTag, masked } from '../src/engine/engine';
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

const AK = 'LTAI5tSecretTestKey'; // 长度 > 7，脱敏后为 LTAI5tS***

function keepAliveAccount(over: boolean, remark: string, name = 'i-keepalive'): Account {
  return {
    id: 7,
    name,
    remark,
    regionId: 'cn-hangzhou',
    instanceId: 'i-keepalive',
    accessKeyId: AK,
    accessKeySecret: 'secret',
    siteType: 'china',
    maxTraffic: 100,
    trafficUsed: over ? 95 : 10,
    startTime: '08:00',
    stopTime: '23:00',
    scheduleEnabled: false,
    cycleEnabled: false,
    keepAlive: true, // 账号级保活开启（全局开关见 baseConfig）
    shutdownMode: '',
    instanceStatus: 'Stopped',
    updatedAt: new Date().toISOString(),
  } as unknown as Account;
}

function baseConfig() {
  return {
    ...DEFAULT_CONFIG,
    timezone: 'UTC',
    trafficThreshold: 90, // 95% 越限 / 10% 不越限
    thresholdAction: 'stop_and_notify',
    enableScheduleMail: false,
    enableBilling: false,
    keepAlive: true,
    monitorInterval: 5,
  };
}

afterEach(() => vi.restoreAllMocks());

/** 跑一轮 processAccount，回收所有 addLog 调用（type, message） */
async function runKeepAlive(over: boolean, remark: string, name = 'i-keepalive') {
  const env = fakeEnv();
  const logs: { type: string; message: string }[] = [];
  const control = vi.spyOn(aliyun, 'controlInstance').mockResolvedValue(undefined as never);
  vi.spyOn(aliyun, 'getTraffic').mockResolvedValue(over ? 95 : 10);
  vi.spyOn(aliyun, 'getInstanceStatus').mockResolvedValue('Stopped');
  vi.spyOn(store, 'addLog').mockImplementation(async (_e, type, message) => { logs.push({ type, message }); });
  vi.spyOn(store, 'writeRuntimeBatch').mockResolvedValue(undefined as never);
  vi.spyOn(store, 'updateRuntime').mockResolvedValue(undefined as never);
  vi.spyOn(store, 'addOutbox').mockResolvedValue(undefined as never);
  vi.spyOn(store, 'recordActionEvent').mockResolvedValue(true);
  vi.spyOn(store, 'deleteActionEvent').mockResolvedValue(undefined as never);

  const res = await processAccount(env, keepAliveAccount(over, remark, name), true, baseConfig() as never);
  return { res, logs, control };
}

describe('accountTag：日志账号标签', () => {
  it('有备注时输出「备注｜脱敏 AK」', () => {
    expect(accountTag({ accessKeyId: AK, remark: '测试机-A', name: 'i-x' })).toBe('测试机-A｜LTAI5tS***');
  });

  it('备注为空时回退账号名', () => {
    expect(accountTag({ accessKeyId: AK, remark: '', name: 'i-x' })).toBe('i-x｜LTAI5tS***');
    expect(accountTag({ accessKeyId: AK, remark: '   ', name: 'i-x' })).toBe('i-x｜LTAI5tS***');
  });

  it('两者都为空时退化为纯脱敏 AK（与历史日志观感一致）', () => {
    expect(accountTag({ accessKeyId: AK, remark: '', name: '' })).toBe('LTAI5tS***');
  });

  it('永不泄漏完整 AK（不论备注是否为空）', () => {
    for (const acc of [
      { accessKeyId: AK, remark: '备注', name: 'i-x' },
      { accessKeyId: AK, remark: '', name: '' },
      { accessKeyId: 'SHORTKEY', remark: '', name: '' },
    ]) {
      const tag = accountTag(acc);
      expect(tag).not.toBe(acc.accessKeyId);
      // 短 AK 也必须是脱敏形态（masked 的兜底：整体加 ***）
      expect(tag).toContain('***');
    }
    expect(masked('SHORT')).toBe('SHORT***');
  });
});

describe('保活日志包含账号备注（用户报障回归）', () => {
  it('跳过保活（超限阻断）的日志带备注，且不含完整 AK', async () => {
    const { logs, res } = await runKeepAlive(true, '测试机-A');
    const keep = logs.filter((l) => l.type === 'keepalive');
    expect(keep.length).toBe(1);
    expect(keep[0].message).toContain('实例已停止但保活未执行');
    expect(keep[0].message).toContain('测试机-A｜LTAI5tS***');
    expect(keep[0].message).toContain('流量已达阈值');
    // 完整 AK 一个字符都不能进日志
    for (const l of logs) expect(l.message).not.toContain(AK);
    expect(res.actions).not.toContain('keepalive_start');
  });

  it('保活启动成功的日志带备注，且不含完整 AK', async () => {
    const { logs, control, res } = await runKeepAlive(false, '测试机-B');
    expect(control).toHaveBeenCalledTimes(1);
    expect(control.mock.calls[0][2]).toBe('start');
    const keep = logs.filter((l) => l.type === 'keepalive' && l.message.includes('实例保活启动'));
    expect(keep.length).toBe(1);
    expect(keep[0].message).toContain('测试机-B｜LTAI5tS***');
    for (const l of logs) expect(l.message).not.toContain(AK);
    expect(res.actions).toContain('keepalive_start');
  });

  it('备注与账号名都为空时保活日志退化为脱敏 AK，不再出现「无名」记录', async () => {
    const { logs } = await runKeepAlive(true, '', '');
    const keep = logs.filter((l) => l.type === 'keepalive');
    expect(keep.length).toBe(1);
    expect(keep[0].message).toContain('[LTAI5tS***]');
    expect(keep[0].message).not.toContain(AK);
  });
});
