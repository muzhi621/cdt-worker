// 触发密钥托管（D1 加密存储）的优先级单测（最小 D1 桩）
// 关键语义：托管值优先于 env.CRON_SECRET；托管值损坏时回退 env 而非抛错（监控不能断）。
import { describe, it, expect, beforeEach } from 'vitest';
import { resolveCronSecret, resetCronSecretCache } from '../src/store/store';
import { encrypt, type Env } from '../src/security/security';

const MASTER = Buffer.from(new Uint8Array(32).map((_, i) => i + 1)).toString('base64');

function fakeDb(row: Record<string, unknown> | null) {
  return {
    prepare: (_sql: string) => ({
      bind: (..._args: unknown[]) => ({
        first: async () => row,
      }),
      first: async () => row,
    }),
  } as unknown as Env['DB'];
}

function envWith(row: Record<string, unknown> | null, cronSecret?: string): Env {
  return { DB: fakeDb(row), CRON_SECRET: cronSecret, CDT_MASTER_KEY: MASTER } as unknown as Env;
}

describe('resolveCronSecret（触发密钥托管优先级）', () => {
  beforeEach(() => resetCronSecretCache());

  it('无托管值 → 回退 env.CRON_SECRET（既有部署行为不变）', async () => {
    expect(await resolveCronSecret(envWith(null, 'env-secret-value'))).toBe('env-secret-value');
  });

  it('有托管值 → 优先于 env（管理台修改后立即生效）', async () => {
    const enc = await encrypt(envWith(null), 'managed-secret-123');
    expect(await resolveCronSecret(envWith({ value: enc }, 'env-secret-value'))).toBe('managed-secret-123');
  });

  it('托管值损坏（如更换了 CDT_MASTER_KEY）→ 回退 env，不抛错、监控不断', async () => {
    const broken = 'enc:v1:!!!not-valid-base64-or-ciphertext!!!';
    expect(await resolveCronSecret(envWith({ value: broken }, 'env-secret-value'))).toBe('env-secret-value');
  });

  it('两边都没有 → 空串（外部匿名触发会被 401）', async () => {
    expect(await resolveCronSecret(envWith(null))).toBe('');
  });
});
