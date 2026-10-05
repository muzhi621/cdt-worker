// 日志频率审计（2026-10-05）：逐条核对全部日志写入点的「记录频率」与「判定/执行频率」是否一致。
//
// 起因：用户报障「保活日志怎么是 1 个小时一次」（keepalive-skip 硬编码按小时去抖，
// 见 keepalive-skip-cadence.test.ts），随后要求「检查其他日志是否有同样的问题」。
//
// 审计结论（全部 recordActionEvent / addLog 写入点逐条看过）：
//   ❌ DDNS「无值班机器」告警    零去重 + 每轮判定都命中 → 288 行/天（window 模式夜间空档必现）
//   ❌ 登录拦截日志              零去重 + 落在公开且可被无限刷的路径上 → 请求数 = 日志行数
//   ❌ 通知凭据解密失败日志      零去重 + 由 getConfig 调用 → 接口调用次数 = 日志行数
//   ✅ 保活跳过                  已改为「监控间隔」粒度（上一批修复）
//   ✅ 触发源 401 / 已关闭 / 断档  刻意每小时一条（持续态提醒，不是工作日志）
//   ✅ 流量·状态·账单查询失败、DDNS 同步失败、保活启动失败
//                                错误类：每次真实失败留一条，不去重（去重会让重试不可见）
//   ✅ 定时/循环启停、阈值告警、状态变化、DDNS 切换、通知投递
//                                事件驱动，频率天然等于真实发生次数
//   ✅ 数据清理（每天）、循环参数非法（每天）、循环相位修正（每天）
//                                持续态，本来就该低频
//
// 统一约定（同时写进 src/engine/time.ts::intervalBucket 注释）：
//   例行态日志 → 去重粒度 = 监控间隔（intervalBucket）；错误类日志 → 不去重。
// 本文件锁定上面三个 ❌ 的修复，防止再退回「零去重」或「硬编码小时/自然日」。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as rootStore from '../src/store/store';
import * as ddnsStore from '../src/ddns/store';
import { runDdnsSync } from '../src/ddns/sync';
import { decryptNotifyConfig } from '../src/store/store';
import { intervalBucket } from '../src/engine/time';
import type { Env } from '../src/security/security';

// 测试环境没有 Cloudflare 运行时，依赖树里的 cloudflare:sockets 必须桩掉
vi.mock('cloudflare:sockets', () => ({
  connect: () => { throw new Error('cloudflare:sockets 未在本测试环境实现（桩）'); },
}));

function fakeEnv(): Env {
  return { DB: {} as unknown as Env['DB'], CDT_MASTER_KEY: '' } as unknown as Env;
}

/** 内存版 `INSERT OR IGNORE` 语义（action_events 唯一键）+ 收集 logs 行 */
function fakeDb() {
  const logged: { type: string; message: string }[] = [];
  const events = new Set<string>();
  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            run: async () => {
              if (sql.includes('INTO action_events')) {
                const key = String(args[0]);
                if (events.has(key)) return { meta: { changes: 0 } };
                events.add(key);
                return { meta: { changes: 1 } };
              }
              if (sql.includes('INTO logs')) {
                logged.push({ type: String(args[0]), message: String(args[1]) });
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as Env['DB'];
  return { logged, events, env: { DB, CDT_MASTER_KEY: '' } as unknown as Env };
}

afterEach(() => vi.restoreAllMocks());

/* ------------------------------------------------------------------ *
 * ① 统一约定：intervalBucket —— 例行态日志的去重粒度必须是监控间隔
 * ------------------------------------------------------------------ */

describe('intervalBucket：例行态日志的去重粒度 = 监控间隔', () => {
  it('桶号 = floor(now / (间隔分钟 × 60000))，与保活跳过的公式同源', () => {
    const t = 1_800_000_000_000; // 固定时间戳，避免依赖真实时钟
    expect(intervalBucket(t, 5)).toBe(Math.floor(t / 300_000));
    expect(intervalBucket(t, 60)).toBe(Math.floor(t / 3_600_000));
    expect(intervalBucket(t, 5)).toBe(Math.floor(t / 3_600_000) * 12 + 0);
  });

  it('同一监控窗口内是同一个桶，跨窗口必定换桶', () => {
    const base = 1_800_000_000_000; // 恰好能被 5 分钟整除
    expect(intervalBucket(base, 5)).toBe(intervalBucket(base + 299_999, 5));
    expect(intervalBucket(base, 5)).not.toBe(intervalBucket(base + 300_000, 5));
  });

  it('非法/缺失间隔退化为 1 分钟桶，绝不出现除零或 NaN 桶', () => {
    const t = 1_800_000_000_000;
    for (const bad of [0, -5, NaN, undefined as unknown as number]) {
      const b = intervalBucket(t, bad);
      expect(Number.isFinite(b)).toBe(true);
      expect(b).toBe(Math.floor(t / 60_000));
    }
  });
});

/* ------------------------------------------------------------------ *
 * ② DDNS「无值班机器」告警：每轮都会命中，必须去重
 * ------------------------------------------------------------------ */

/** window 模式 + 空时段（00:00-00:00）→ 任何时刻都选不出值班机器，且没配兜底 IP */
function noDutyGroups(): never {
  return [{
    id: 3, name: 'W_GROUP', mode: 'window', timezone: 'UTC',
    switch_time: '', anchor_date: '', anchor_at: '', fallback_ip: '', enabled: true,
    members: [{
      machineId: 1, days: 1, windowStart: '00:00', windowEnd: '00:00',
      sortOrder: 0, name: 'M1', ip: '1.1.1.1', machineEnabled: true,
    }],
    records: [{
      id: 9, group_id: 3, provider: 'cloudflare', zone: 'example.com', host: 'a',
      ttl: 600, zone_id: '', record_id: '', credential_id: 0, credential_enc: '',
      current_ip: '1.1.1.1', enabled: true, last_sync_at: null, last_error: '',
    }],
  }] as unknown as never;
}

async function runNoDuty(intervalMinutes: number, rounds: number) {
  const env = fakeEnv();
  const seen = new Set<string>();
  const keys: string[] = [];
  const logs: { type: string; message: string }[] = [];
  vi.spyOn(ddnsStore, 'listGroups').mockResolvedValue(noDutyGroups());
  vi.spyOn(rootStore, 'addLog').mockImplementation(async (_e, type, message) => { logs.push({ type, message }); });
  vi.spyOn(rootStore, 'recordActionEvent').mockImplementation(async (_e, key) => {
    keys.push(key);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (let i = 0; i < rounds; i++) await runDdnsSync(env, { intervalMinutes });
  return {
    keys: keys.filter((k) => k.startsWith('ddns-noonduty:')),
    warnLogs: logs.filter((l) => l.message.includes('无值班机器')),
  };
}

describe('DDNS 无值班机器告警的去重粒度', () => {
  it('连续三轮（同一监控窗口）只留一条告警，不再 288 行/天', async () => {
    const { keys, warnLogs } = await runNoDuty(5, 3);
    expect(keys).toHaveLength(3);                        // 每轮都判定了
    expect(new Set(keys).size).toBe(1);                  // 但落在同一个桶
    expect(warnLogs).toHaveLength(1);                    // 所以只写一条日志
    expect(warnLogs[0].type).toBe('warning');
    expect(warnLogs[0].message).toContain('当前无值班机器且未配置兜底 IP');
  });

  it('粒度随监控间隔变化：5 分钟桶 = 60 分钟桶 × 12（不再拍死一个粒度）', async () => {
    const before = Math.floor(Date.now() / (5 * 60_000));
    const { keys: k5 } = await runNoDuty(5, 1);
    const { keys: k60 } = await runNoDuty(60, 1);
    const after = Math.floor(Date.now() / (5 * 60_000));
    const bucket5 = Number(k5[0].split(':').pop());
    const bucket60 = Number(k60[0].split(':').pop());
    expect([before, after]).toContain(bucket5);
    expect(bucket5).toBeGreaterThanOrEqual(bucket60 * 12);
    expect(bucket5).toBeLessThanOrEqual(bucket60 * 12 + 12);
    expect(k5[0]).toMatch(/^ddns-noonduty:3:\d+$/);
  });
});

/* ------------------------------------------------------------------ *
 * ③ 通知凭据解密失败：由 getConfig 调用，必须按「字段/天」去重
 *    （这里走真实 store 代码 + 内存 D1，因为调用发生在 store.ts 模块内部，
 *      对同模块的 addLog 做 vi.spyOn 拦不到）
 * ------------------------------------------------------------------ */

/** 超过 ENCRYPTED_PREFIX 但长度不足 12 字节 → decrypt 必然抛错，且不需要真实主密钥 */
const BAD_CIPHERTEXT = 'enc:v1:AAA';

async function runDecrypt(rounds: number) {
  const { logged, env } = fakeDb();
  for (let i = 0; i < rounds; i++) {
    const cfg = { webhook: { url: BAD_CIPHERTEXT, secret: 'not-encrypted-此处不参与' } };
    await decryptNotifyConfig(env, cfg as unknown as Record<string, unknown>);
    await new Promise((r) => setTimeout(r, 0)); // 冲刷 fire-and-forget 的留痕任务
  }
  return logged.filter((l) => l.message.includes('通知凭据解密失败'));
}

describe('通知凭据解密失败日志的去重粒度', () => {
  it('同一字段连续读 3 次只留一条（旧实现是「每次 getConfig 一行」）', async () => {
    const logs = await runDecrypt(3);
    expect(logs).toHaveLength(1);
    expect(logs[0].type).toBe('error');
    // 文案照旧：故障依然看得见，只是不再按请求次数刷屏
    expect(logs[0].message).toContain('通知凭据解密失败，该通道将发送失败：webhook.url');
    expect(logs[0].message).toContain('CDT_MASTER_KEY');
  });

  it('解密失败时字段照旧被置空（绝不把坏密文当明文投递）', async () => {
    const { env } = fakeDb();
    const cfg = { webhook: { url: BAD_CIPHERTEXT, secret: 'plain-secret' } };
    const out = await decryptNotifyConfig(env, cfg as unknown as Record<string, unknown>) as {
      webhook: { url: string; secret: string };
    };
    expect(out.webhook.url).toBe('');
    expect(out.webhook.secret).toBe('plain-secret'); // 非 enc: 前缀的旧库明文原样透传
  });
});

/* ------------------------------------------------------------------ *
 * ④ 登录拦截日志：公开端点，必须去重（handler 未导出，用源码断言锁定）
 * ------------------------------------------------------------------ */

describe('登录拦截日志必须去重', () => {
  const src = readFileSync(new URL('../src/http/server.ts', import.meta.url), 'utf8');

  it('「登录尝试过多已拦截」必须挂在 recordActionEvent 的去重键之后', () => {
    const idx = src.indexOf('登录尝试过多已拦截');
    expect(idx).toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, idx - 800), idx);
    expect(before).toMatch(/login_blocked/);       // 按 IP + 小时分桶
    expect(before).toMatch(/recordActionEvent/);   // 且真的用它做了去重
    expect(before).toMatch(/slice\(0, 13\)/);      // 粒度是小时（YYYY-MM-DDTHH）
  });
});

/* ------------------------------------------------------------------ *
 * ⑤ 反面锁定：刻意低频 / 刻意不去重的写入点不许被「顺手改成监控同频」
 * ------------------------------------------------------------------ */

describe('刻意的粒度不能被顺手改掉', () => {
  const serverSrc = readFileSync(new URL('../src/http/server.ts', import.meta.url), 'utf8');

  it('触发源 401 / 已关闭 / 断档 三个持续态提醒保持「每渠道每小时一条」', () => {
    for (const key of ['trigger_authfail', 'trigger_disabled', 'trigger_gap']) {
      expect(serverSrc).toContain('`' + key + ':${source}:${hour}`');
    }
    const hours = serverSrc.match(/new Date\(\)\.toISOString\(\)\.slice\(0, 13\)/g) ?? [];
    expect(hours.length).toBeGreaterThanOrEqual(3);
  });

  it('错误类日志（查询失败 / 同步失败）保持不去重：每次真实失败都要留痕', () => {
    const engineSrc = readFileSync(new URL('../src/engine/engine.ts', import.meta.url), 'utf8');
    // 保活跳过（例行态）必须过 intervalBucket，查询失败（错误）必须不过
    expect(engineSrc).toMatch(/keepalive-skip:\$\{account\.id\}:\$\{skipBucket\}/);
    for (const msg of ['流量查询失败', '实例状态查询失败', '保活启动失败']) {
      expect(engineSrc).toContain(msg);
    }
    // 禁止再出现按小时/自然日硬编码的例行态去抖键
    expect(engineSrc).not.toMatch(/keepalive-skip:\$\{account\.id\}:\$\{localFields/);
  });
});
