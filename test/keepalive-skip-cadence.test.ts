// 回归测试：保活「跳过」日志的节流粒度必须与**监控触发时效**（monitorInterval）同步。
//
// 背景（用户报障）：监控每 5 分钟跑一轮，保活也每轮都在检查，但跳过日志硬编码按小时去抖
// （keepalive-skip:{id}:{YYYYMMDDHH}），于是「保活」标签页里每 60 分钟才出现一行，
// 看起来像保活是小时级、根本没跟着监控走，实际每轮都检查过、只是被日志节流吃掉了。
//
// 修复：去抖桶 = monitorInterval 分钟（把时间戳对齐到监控间隔的格子里），
// 日志频率与监控触发时效严格同频；写入量仍被监控节流天然兜住，不会刷屏。
// 本测试锁定该语义——若有人把桶改回「按小时」或「按自然日」，会立刻变红。
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

const ACCOUNT_ID = 7;

/** 实例已停止 + 流量超限 → 保活被阻断，必写「跳过保活」日志 */
function blockedAccount(): Account {
  return {
    id: ACCOUNT_ID,
    name: 'i-keepalive',
    remark: '测试机-A',
    regionId: 'cn-hangzhou',
    instanceId: 'i-keepalive',
    accessKeyId: 'LTAI5tSecretTestKey',
    accessKeySecret: 'secret',
    siteType: 'china',
    maxTraffic: 100,
    trafficUsed: 95, // >= 90% 阈值 → overThreshold
    startTime: '08:00',
    stopTime: '23:00',
    scheduleEnabled: false,
    cycleEnabled: false,
    keepAlive: true,
    shutdownMode: '',
    instanceStatus: 'Stopped',
    updatedAt: new Date().toISOString(),
  } as unknown as Account;
}

function baseConfig(intervalMinutes: number) {
  return {
    ...DEFAULT_CONFIG,
    timezone: 'UTC',
    trafficThreshold: 90,
    thresholdAction: 'stop_and_notify',
    enableScheduleMail: false,
    enableBilling: false,
    keepAlive: true,
    monitorInterval: intervalMinutes,
  };
}

/**
 * 跑 n 轮 processAccount，recordActionEvent 模拟真实的 `INSERT OR IGNORE`（同 key 第二次返回 false）。
 * 返回本次记录到的全部幂等键与日志。
 */
async function run(intervalMinutes: number, rounds = 1) {
  const env = fakeEnv();
  const seen = new Set<string>();
  const keys: string[] = [];
  const logs: { type: string; message: string }[] = [];
  vi.spyOn(aliyun, 'controlInstance').mockResolvedValue(undefined as never);
  vi.spyOn(aliyun, 'getTraffic').mockResolvedValue(95);
  vi.spyOn(aliyun, 'getInstanceStatus').mockResolvedValue('Stopped');
  vi.spyOn(store, 'addLog').mockImplementation(async (_e, type, message) => { logs.push({ type, message }); });
  vi.spyOn(store, 'writeRuntimeBatch').mockResolvedValue(undefined as never);
  vi.spyOn(store, 'updateRuntime').mockResolvedValue(undefined as never);
  vi.spyOn(store, 'addOutbox').mockResolvedValue(undefined as never);
  vi.spyOn(store, 'deleteActionEvent').mockResolvedValue(undefined as never);
  vi.spyOn(store, 'recordActionEvent').mockImplementation(async (_e, key) => {
    keys.push(key);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (let i = 0; i < rounds; i++) {
    await processAccount(env, blockedAccount(), true, baseConfig(intervalMinutes) as never);
  }
  return {
    keys: keys.filter((k) => k.startsWith('keepalive-skip:')),
    // 剥离前面可能混入的其它类型日志，只看保活标签页
    keepLogs: logs.filter((l) => l.type === 'keepalive'),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('保活跳过日志的节流粒度 = 监控触发时效', () => {
  it('间隔 5 分钟：去抖桶按 5 分钟切分，日志每 5 分钟窗口才会出现一行', async () => {
    const before = Math.floor(Date.now() / (5 * 60_000));
    const { keys, keepLogs } = await run(5);
    const after = Math.floor(Date.now() / (5 * 60_000));

    expect(keepLogs).toHaveLength(1);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^keepalive-skip:${ACCOUNT_ID}:\\d+$`));
    const bucket = Number(keys[0].split(':').pop());
    // 允许边界上跨一格（计算前后各取一次）
    expect([before, after]).toContain(bucket);
  });

  it('去抖桶随 monitorInterval 变化（旧实现忽略间隔、两种配置会撞成同一个 key）', async () => {
    const { keys: k5 } = await run(5);
    const { keys: k60 } = await run(60);
    const bucket5 = Number(k5[0].split(':').pop());
    const bucket60 = Number(k60[0].split(':').pop());

    // 5 分钟桶 = 60 分钟桶 × 12 + 小时内的偏移（0~11）
    expect(bucket5).toBeGreaterThanOrEqual(bucket60 * 12);
    expect(bucket5).toBeLessThanOrEqual(bucket60 * 12 + 12);
    // 关键：粒度越细，桶值越大，且不再是旧实现的 YYYYMMDDHH
    expect(bucket5).toBeGreaterThan(bucket60);
    expect(String(bucket5)).not.toHaveLength(10); // 2026100517 这类 10 位小时桶
    expect(String(bucket5).startsWith('2026')).toBe(false);
  });

  it('同一轮监控窗口内重复执行只留一条（不会刷屏 / 不浪费 D1 写入）', async () => {
    const { keys, keepLogs } = await run(5, 3); // 连续三轮，落在同一个 5 分钟桶
    // 记录三次尝试，但只有第一次是 fresh → 只写一条日志
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(keepLogs).toHaveLength(1);
  });
});
