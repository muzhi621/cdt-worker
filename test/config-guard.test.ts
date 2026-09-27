// 配置写入安全护栏的回归单测：数值白名单 / 假值陷阱 / 保活列
import { describe, it, expect } from 'vitest';
import { clampInt, parseClampedNum } from '../src/store/store';

describe('clampInt（抵御 parseInt || default 假值陷阱）', () => {
  it('负数脏值被钳制到下限，而非穿透成负阈值触发批量停机', () => {
    // 关键回归：旧代码 parseInt('-50') || 90 === -50，会让 percentage >= -50 恒真
    expect(clampInt('-50', 1, 100, 90)).toBe(1);
    expect(clampInt('-1', 1, 100, 90)).toBe(1);
  });

  it('科学计数法不再被 parseInt 截断成 1', () => {
    // 旧代码 parseInt('1e9') === 1（截断到首个非数字字符）
    expect(clampInt('1e9', 1, 100, 90)).toBe(100);
  });

  it('越界值夹取到最近边界', () => {
    expect(clampInt('150', 1, 100, 90)).toBe(100);
    expect(clampInt('999999', 60, 86400, 600)).toBe(86400);
  });

  it('空串 / 非数字回退默认值', () => {
    expect(clampInt('', 1, 100, 90)).toBe(90);
    expect(clampInt(undefined, 1, 100, 90)).toBe(90);
    expect(clampInt('abc', 1, 100, 90)).toBe(90);
  });

  it('合法值原样保留', () => {
    expect(clampInt('50', 1, 100, 90)).toBe(50);
    expect(clampInt('600', 60, 86400, 600)).toBe(600);
  });
});

describe('parseClampedNum（saveConfig 数值校验：未传放行 / 非法拒绝）', () => {
  it('关键回归：未传(undefined/null/空串)必须放行，不得与「非法值」共用 null 拒绝', () => {
    // 542c57a 回归 bug：saveConfig 把「未传 logRetentionDays」映射成 null，再与
    // 「非法值也是 null」共用同一个 400 判断——所有不携带该字段的 /api/v1/config
    // 保存（含账号配置、保活开关）全部被拒，界面报「日志保留天数必须在 1~365 之间」。
    // 修复后未传 → fallback 放行，是否落库由「显式传入才写」的分支单独决定。
    expect(parseClampedNum(undefined, 1, 365, 30)).toBe(30);
    expect(parseClampedNum(null, 1, 365, 30)).toBe(30);
    expect(parseClampedNum('', 1, 365, 30)).toBe(30);
  });

  it('非法值（NaN）返回 null 供调用方拒绝，而不是悄悄回退', () => {
    expect(parseClampedNum('abc', 1, 365, 30)).toBeNull();
  });

  it('越界值返回 null 供调用方拒绝，而不是钳到边界', () => {
    expect(parseClampedNum(0, 1, 365, 30)).toBeNull();
    expect(parseClampedNum(366, 1, 365, 30)).toBeNull();
    expect(parseClampedNum('-50', 1, 100, 90)).toBeNull();
  });

  it('合法值四舍五入后原样保留', () => {
    expect(parseClampedNum(30, 1, 365, 30)).toBe(30);
    expect(parseClampedNum('90.4', 1, 100, 90)).toBe(90);
  });
});
