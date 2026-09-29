// 「循环开关机」字段落库验证：前端提交的值是否真的写进 D1、读出来是否和引擎语义一致
import { describe, it, expect } from 'vitest';
import { listAccounts, saveAccount, updateAccountConfig } from '../src/store/store';
import type { Env } from '../src/security/security';

interface Call { sql: string; args: unknown[] }

// 最小 D1 桩：记录每条 SQL 与其绑定参数
function spyDb(rows: Record<string, unknown>[] = []) {
  const calls: Call[] = [];
  const db = {
    prepare: (sql: string) => {
      const runner = {
        run: async () => ({ meta: { changes: 1, last_row_id: 7 } }),
        first: async () => rows[0] ?? null,
        all: async () => ({ results: rows }),
      };
      const stmt = {
        bind: (...args: unknown[]) => { calls.push({ sql, args }); return runner; },
        run: async () => { calls.push({ sql, args: [] }); return runner.run(); },
        first: async () => { calls.push({ sql, args: [] }); return runner.first(); },
        all: async () => { calls.push({ sql, args: [] }); return runner.all(); },
      };
      return stmt;
    },
  };
  return { db: db as unknown as Env['DB'], calls };
}

function envOf(db: Env['DB']): Env {
  return { DB: db, CDT_MASTER_KEY: '' } as unknown as Env;
}

// 一行 accounts 记录（不含循环初始状态列，模拟 ALTER 前的老库）
function row(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1, name: 'a', remark: '', region_id: 'cn-hangzhou', instance_id: 'i-1',
    access_key_id_enc: 'LTAI***', access_key_secret_enc: 'sk',
    site_type: 'china', max_traffic: 100,
    start_time: '', stop_time: '', schedule_enabled: 0,
    cycle_enabled: 1, cycle_anchor: '2026-09-30 00:00:00', cycle_days: 10,
    keep_alive: 0, shutdown_mode: '', instance_status: 'Stopped',
    traffic_used: 0, updated_at: '2026-09-29 00:00:00',
    ...extra,
  };
}

describe('循环初始状态 · 落库与读取', () => {
  it('老库缺列时读为「开机」（不能读成 false，否则已配置账号被静默反相）', async () => {
    const { db } = spyDb([row()]);
    const [acc] = await listAccounts(envOf(db));
    expect(acc.cycleStartOn).toBe(true);
  });

  it('库中 0 → 关机起步；1 → 开机起步', async () => {
    const off = spyDb([row({ cycle_start_on: 0 })]);
    expect((await listAccounts(envOf(off.db)))[0].cycleStartOn).toBe(false);
    const on = spyDb([row({ cycle_start_on: 1 })]);
    expect((await listAccounts(envOf(on.db)))[0].cycleStartOn).toBe(true);
  });

  it('新增账号：cycle_start_on 写入 INSERT（false → 0）', async () => {
    const { db, calls } = spyDb([]);
    await saveAccount(envOf(db), {
      accessKeyId: '', accessKeySecret: '', name: 'n', remark: '', regionId: 'cn-hangzhou',
      instanceId: '', siteType: 'china', maxTraffic: 100, startTime: '', stopTime: '',
      scheduleEnabled: false, keepAlive: false, shutdownMode: '',
      cycleEnabled: true, cycleAnchor: '2026-09-30 00:00:00', cycleDays: 10, cycleStartOn: false,
      instanceStatus: '', trafficUsed: 0, updatedAt: '',
    } as never);
    const ins = calls.find((c) => c.sql.startsWith('INSERT INTO accounts'))!;
    expect(ins.sql).toContain('cycle_start_on');
    expect(ins.args).toContain(0);
  });

  it('编辑账号：传了 cycleStartOn 才写该列，未传不覆盖（改备注不会重置初始状态）', async () => {
    const withVal = spyDb([]);
    await updateAccountConfig(envOf(withVal.db), { id: 1, cycleStartOn: false } as never);
    const sql1 = withVal.calls.find((c) => c.sql.startsWith('UPDATE accounts'))!;
    expect(sql1.sql).toContain('cycle_start_on=?');
    expect(sql1.args).toContain(0);

    const without = spyDb([]);
    await updateAccountConfig(envOf(without.db), { id: 1, remark: '只改备注' } as never);
    const sql2 = without.calls.find((c) => c.sql.startsWith('UPDATE accounts'))!;
    expect(sql2.sql).not.toContain('cycle_start_on');
  });
});
