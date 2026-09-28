// P0-T2 / P2-6 回归测试：summary() 每账号只应产生 1 次账单查询（billingSnapshot 合并
// balance + instance_bill 两个 kind），不得再出现独立的 billingCache 调用。
// 这是第三轮预算审查遗留、挂了一天的确定性浪费（每账号每刷新多 1 个 subrequest）。
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as store from '../src/store/store';
import { summary } from '../src/engine/engine';
import type { Env } from '../src/security/security';

// 测试环境没有 Cloudflare 运行时，engine 依赖树里的 cloudflare:sockets 必须桩掉，
// 否则 vite 无法解析该内置模块（summary 路径不会真正调用 connect，故桩只提供签名）。
vi.mock('cloudflare:sockets', () => ({
  connect: () => { throw new Error('cloudflare:sockets 未在本测试环境实现（桩）'); },
}));

function fakeEnv(): Env {
  return { DB: {} as unknown as Env['DB'], CDT_MASTER_KEY: '' } as unknown as Env;
}

afterEach(() => vi.restoreAllMocks());

describe('summary 账单查询次数（P0-T2 回归）', () => {
  it('每账号只产生 1 次 billing 查询，且不调用 billingCache', async () => {
    const snapSpy = vi.spyOn(store, 'billingSnapshot').mockResolvedValue({
      balance: { hit: true, value: { amount: 9.9, currency: 'CNY' } },
      instance_bill: { hit: true, value: { totalCost: 88 } },
    } as unknown as Record<string, { hit: boolean; value?: unknown }>);
    // 关键断言：合并后绝不应再出现独立的 billingCache 调用
    const cacheSpy = vi.spyOn(store, 'billingCache').mockResolvedValue({ hit: false } as never);
    vi.spyOn(store, 'getConfig').mockResolvedValue({
      timezone: 'Asia/Shanghai',
      enableBilling: true,
      shutdownMode: 'StopCharging',
      trafficThreshold: 80,
      keepAlive: false,
      accounts: [
        { id: 1, accessKeyId: 'AK1', remark: 'A', instanceStatus: 'Running', trafficUsed: 5, maxTraffic: 100, updatedAt: '', regionId: 'cn-hangzhou', instanceId: 'i-1', scheduleEnabled: false, keepAlive: false },
        { id: 2, accessKeyId: 'AK2', remark: 'B', instanceStatus: 'Running', trafficUsed: 15, maxTraffic: 100, updatedAt: '', regionId: 'cn-beijing', instanceId: 'i-2', scheduleEnabled: false, keepAlive: false },
      ],
    } as unknown as store.Config);

    const res = await summary(fakeEnv());
    expect(res.length).toBe(2);
    // 每账号 1 次 billingSnapshot（合并两个 kind），共 2 次
    expect(snapSpy).toHaveBeenCalledTimes(2);
    // 不允许残留的独立 billingCache 调用
    expect(cacheSpy).not.toHaveBeenCalled();
  });
});
