// billingCache TTL 逻辑单测（用最小 D1 桩替代真实数据库）
import { describe, it, expect } from 'vitest';
import { billingCache } from '../src/store/store';
import type { Env } from '../src/security/security';

// 桩：prepare(...).bind(...).first() 返回预设行
function fakeDb(row: Record<string, unknown> | null) {
  return {
    prepare: (_sql: string) => ({
      bind: (..._args: unknown[]) => ({
        first: async () => row,
      }),
    }),
  } as unknown as Env['DB'];
}

function envWithRow(row: Record<string, unknown> | null): Env {
  return { DB: fakeDb(row), CDT_MASTER_KEY: '' } as unknown as Env;
}

type Bal = { amount: number; currency: string };

function utcStamp(msAgo: number): string {
  // 模拟 D1 datetime('now') 的 UTC "YYYY-MM-DD HH:mm:ss" 格式
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
}

describe('billingCache TTL', () => {
  it('缓存存在且未过期 → hit', async () => {
    const env = envWithRow({ value: JSON.stringify({ amount: 12.34, currency: 'CNY' }), updated_at: utcStamp(5 * 60 * 1000) });
    const r = await billingCache<Bal>(env, 1, 'balance', '', 6);
    expect(r.hit).toBe(true);
    expect(r.value?.amount).toBe(12.34);
  });

  it('超过 TTL → miss（东八区曾因按本地时间解析偏移 8 小时）', async () => {
    const env = envWithRow({ value: JSON.stringify({ amount: 1 }), updated_at: utcStamp(11 * 3600 * 1000) });
    const r = await billingCache<Bal>(env, 1, 'balance', '', 10);
    expect(r.hit).toBe(false);
  });

  it('UTC 时间戳必须按 UTC 解析：11 小时前写入对 10h TTL 是过期（若误按 UTC+8 解析会差 8h）', async () => {
    const env = envWithRow({ value: JSON.stringify({ amount: 1 }), updated_at: utcStamp(9 * 3600 * 1000) });
    const r = await billingCache<Bal>(env, 1, 'balance', '', 10);
    expect(r.hit).toBe(true); // 9h < 10h TTL
  });

  it('无记录 → miss；value 损坏 → miss 而非抛错', async () => {
    expect((await billingCache<Bal>(envWithRow(null), 1, 'balance', '', 6)).hit).toBe(false);
    const broken = envWithRow({ value: '{not-json', updated_at: utcStamp(0) });
    expect((await billingCache<Bal>(broken, 1, 'balance', '', 6)).hit).toBe(false);
  });
});
