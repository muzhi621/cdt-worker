// 配置写入安全护栏的回归单测：数值白名单 / 假值陷阱 / 保活列
import { describe, it, expect } from 'vitest';
import { clampInt } from '../src/store/store';

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
