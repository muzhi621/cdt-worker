// billingSnapshot 单测：一次查询取回多个 kind，TTL 与 cycle 精确匹配（P0-R2 回归测试）
import { describe, it, expect } from 'vitest';
import { billingSnapshot } from '../src/store/store';
import type { Env } from '../src/security/security';

// 桩：prepare(...).bind(...).all() 返回预设行集合
function fakeDb(rows: Record<string, unknown>[]) {
  return {
    prepare: (_sql: string) => ({
      bind: (..._args: unknown[]) => ({
        all: async () => ({ results: rows }),
      }),
    }),
  } as unknown as Env['DB'];
}

function envWithRows(rows: Record<string, unknown>[]): Env {
  return { DB: fakeDb(rows), CDT_MASTER_KEY: '' } as unknown as Env;
}

function utcStamp(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().slice(0, 19).replace('T', ' ');
}

type Bal = { amount: number; currency: string };
type Bill = { totalCost: number };

describe('billingSnapshot（P0-R2 一次查询取回多 kind）', () => {
  it('balance 与 instance_bill 同轮一次命中', async () => {
    const env = envWithRows([
      { kind: 'balance', cycle: '', value: JSON.stringify({ amount: 9.9, currency: 'CNY' }), updated_at: utcStamp(0) },
      { kind: 'instance_bill', cycle: '2026-09', value: JSON.stringify({ totalCost: 88 }), updated_at: utcStamp(0) },
    ]);
    const snap = await billingSnapshot<Bal | Bill>(env, 1, { balance: '', instance_bill: '2026-09' }, 6);
    expect(snap.balance.hit).toBe(true);
    expect((snap.balance.value as Bal).amount).toBe(9.9);
    expect(snap.instance_bill.hit).toBe(true);
    expect((snap.instance_bill.value as Bill).totalCost).toBe(88);
  });

  it('cycle 不匹配（balance 的 cycle 非空 / 月份对不上）→ 视为未命中', async () => {
    // balance 的 cycle 固定是 ''，若库里存了非空 cycle，不能命中 balance
    const env = envWithRows([
      { kind: 'balance', cycle: '2026-08', value: JSON.stringify({ amount: 1 }), updated_at: utcStamp(0) },
    ]);
    const snap = await billingSnapshot<Bal>(env, 1, { balance: '' }, 6);
    expect(snap.balance.hit).toBe(false);
  });

  it('instance_bill 月份对不上 → 未命中', async () => {
    const env = envWithRows([
      { kind: 'instance_bill', cycle: '2026-08', value: JSON.stringify({ totalCost: 1 }), updated_at: utcStamp(0) },
    ]);
    const snap = await billingSnapshot<Bill>(env, 1, { instance_bill: '2026-09' }, 6);
    expect(snap.instance_bill.hit).toBe(false);
  });

  it('超过 TTL → 未命中（沿用与 billingCache 相同的 UTC 解析）', async () => {
    const env = envWithRows([
      { kind: 'balance', cycle: '', value: JSON.stringify({ amount: 1 }), updated_at: utcStamp(11 * 3600 * 1000) },
    ]);
    const snap = await billingSnapshot<Bal>(env, 1, { balance: '' }, 10);
    expect(snap.balance.hit).toBe(false);
  });

  it('无记录 / value 损坏 → 未命中而非抛错', async () => {
    const empty = await billingSnapshot<Bal>(envWithRows([]), 1, { balance: '' }, 6);
    expect(empty.balance.hit).toBe(false);

    const broken = await billingSnapshot<Bal>(envWithRows([
      { kind: 'balance', cycle: '', value: '{not-json', updated_at: utcStamp(0) },
    ]), 1, { balance: '' }, 6);
    expect(broken.balance.hit).toBe(false);
  });
});
