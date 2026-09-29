// P0-R5-2 回归测试：本轮回填迁移缺失导致「存量 outbox 行 created_at=0 → 首次失败即被放弃」。
// 锁住两点：
//   ① 迁移数组里必须包含一条把存量 created_at=0 行回填的 UPDATE；
//   ② 该 UPDATE 必须用 COALESCE(NULLIF(updated_at,0), unixepoch()) 作为回填值
//      （不能用常量 0，否则等于没回填）。
// 只要这条迁移在，已部署库的老行会在 ensureSchema 时拿到真实入队时间，
// markOutboxRetry 的放弃判定才不会把「刚入队」误判成「1970 年入队」。
import { describe, it, expect } from 'vitest';
import { MIGRATIONS } from '../src/store/schema';

describe('outbox created_at 回填迁移（P0-R5-2 回归）', () => {
  it('迁移数组包含回填 created_at 的 UPDATE，且回填值非 0', () => {
    const backfill = MIGRATIONS.find(
      (s) => /UPDATE notification_outbox SET created_at = COALESCE\(NULLIF\(updated_at, 0\), unixepoch\(\)\) WHERE created_at = 0/.test(s),
    );
    expect(backfill, '缺失 created_at 回填迁移：存量老行会被 markOutboxRetry 直接放弃').toBeDefined();
  });

  it('ADD COLUMN created_at 迁移排在回填之前（列必须先存在）', () => {
    const addIdx = MIGRATIONS.findIndex((s) => /ALTER TABLE notification_outbox ADD COLUMN created_at/.test(s));
    const backIdx = MIGRATIONS.findIndex((s) => /UPDATE notification_outbox SET created_at = COALESCE\(NULLIF\(updated_at, 0\), unixepoch\(\)\) WHERE created_at = 0/.test(s));
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(backIdx).toBeGreaterThan(addIdx);
  });
});
