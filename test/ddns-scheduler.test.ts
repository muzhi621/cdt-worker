// DDNS 排班算法单测：覆盖时段命中、跨天、按天轮转、切换时刻、时区与预览
import { describe, it, expect } from 'vitest';
import {
  pickByRotate, pickByWindow, pickByInterval, pickActiveMachine, previewRotate,
  splitAnchorAt, parseHm, parseDate, formatDate, zonedParts, type DdnsMachine,
} from '../src/ddns/scheduler';

const TZ = 'UTC'; // 统一用 UTC 时区，避免测试受运行环境时区影响

function machine(id: number, name: string, ip: string, extra: Partial<DdnsMachine> = {}): DdnsMachine {
  return {
    id, name, ip, enabled: true, sortOrder: id,
    days: 1, windowStart: '', windowEnd: '', ...extra,
  };
}

/** 构造 UTC 某天某时刻的时间戳 */
function atUtc(y: number, m: number, d: number, hh = 12, mm = 0): number {
  return Date.UTC(y, m - 1, d, hh, mm);
}

describe('parseHm / parseDate', () => {
  it('解析 HH:MM', () => {
    expect(parseHm('00:00')).toBe(0);
    expect(parseHm('08:30')).toBe(510);
    expect(parseHm('23:59')).toBe(1439);
  });
  it('非法时间返回 null', () => {
    expect(parseHm('')).toBeNull();
    expect(parseHm('24:00')).toBeNull();
    expect(parseHm('12:60')).toBeNull();
    expect(parseHm('abc')).toBeNull();
  });
  it('解析 YYYY-MM-DD 与格式化', () => {
    expect(parseDate('1970-01-01')).toBe(0);
    expect(parseDate('bad')).toBeNull();
    expect(formatDate(0)).toBe('1970-01-01');
  });
});

describe('zonedParts', () => {
  it('UTC 时区下取到正确的日期与分钟数', () => {
    const p = zonedParts(atUtc(2026, 9, 28, 23, 30), TZ);
    expect(p.date).toBe('2026-09-28');
    expect(p.minutes).toBe(23 * 60 + 30);
  });
  it('时区非法时退回 UTC 而不抛异常', () => {
    const p = zonedParts(atUtc(2026, 9, 28, 10, 0), 'Not/AZone');
    expect(p.minutes).toBe(600);
  });
});

describe('window 模式：按一天内时间段轮换', () => {
  const machines = [
    machine(1, 'M1', '1.1.1.1', { windowStart: '08:00', windowEnd: '14:00' }),
    machine(2, 'M2', '2.2.2.2', { windowStart: '14:00', windowEnd: '20:00' }),
    machine(3, 'M3', '3.3.3.3', { windowStart: '20:00', windowEnd: '08:00' }), // 跨天
  ];

  it('落在普通时段内命中对应机器', () => {
    expect(pickByWindow(machines, atUtc(2026, 9, 28, 10, 0), TZ).machine?.name).toBe('M1');
    expect(pickByWindow(machines, atUtc(2026, 9, 28, 16, 0), TZ).machine?.name).toBe('M2');
  });

  it('跨天时段的深夜仍命中该机器', () => {
    expect(pickByWindow(machines, atUtc(2026, 9, 28, 23, 0), TZ).machine?.name).toBe('M3');
  });

  it('跨天时段的凌晨（次日）仍命中该机器', () => {
    expect(pickByWindow(machines, atUtc(2026, 9, 28, 3, 0), TZ).machine?.name).toBe('M3');
  });

  it('时段边界：起点闭区间、终点开区间', () => {
    expect(pickByWindow(machines, atUtc(2026, 9, 28, 8, 0), TZ).machine?.name).toBe('M1');
    // 14:00 属于 M2 的起点，不再是 M1
    expect(pickByWindow(machines, atUtc(2026, 9, 28, 14, 0), TZ).machine?.name).toBe('M2');
  });

  it('未配置时段的机器被跳过', () => {
    const noWindow = [machine(1, 'X', '1.1.1.1')];
    expect(pickByWindow(noWindow, atUtc(2026, 9, 28, 10, 0), TZ).machine).toBeNull();
  });

  it('停用或空 IP 的机器不参与排班', () => {
    const list = [machine(1, 'Off', '1.1.1.1', { enabled: false, windowStart: '00:00', windowEnd: '23:59' })];
    expect(pickByWindow(list, atUtc(2026, 9, 28, 10, 0), TZ).machine).toBeNull();
  });
});

describe('rotate 模式：按天数轮转', () => {
  // 三台各值班 10 天，30 天一循环，基准 1970-01-01
  const machines = [
    machine(1, 'A', '1.1.1.1', { days: 10 }),
    machine(2, 'B', '2.2.2.2', { days: 10 }),
    machine(3, 'C', '3.3.3.3', { days: 10 }),
  ];
  const opts = { anchorDate: '1970-01-01', switchTime: '03:00' };

  it('基准日当天由第一台值班', () => {
    expect(pickByRotate(machines, atUtc(1970, 1, 1, 12), TZ, opts).machine?.name).toBe('A');
  });

  it('第 10 天仍是第一台（第 11 天切到第二台）', () => {
    expect(pickByRotate(machines, atUtc(1970, 1, 10, 12), TZ, opts).machine?.name).toBe('A');
    expect(pickByRotate(machines, atUtc(1970, 1, 11, 12), TZ, opts).machine?.name).toBe('B');
  });

  it('第 21 天切到第三台', () => {
    expect(pickByRotate(machines, atUtc(1970, 1, 21, 12), TZ, opts).machine?.name).toBe('C');
  });

  it('30 天后回到第一台（循环）', () => {
    expect(pickByRotate(machines, atUtc(1970, 1, 31, 12), TZ, opts).machine?.name).toBe('A');
    expect(pickByRotate(machines, atUtc(1970, 2, 11, 12), TZ, opts).machine?.name).toBe('B');
  });

  it('切换时刻之前仍算前一天的值班机器', () => {
    // 1970-01-11 01:00 早于 03:00 → 排班日算 01-10（第 10 天）→ 仍是 A
    expect(pickByRotate(machines, atUtc(1970, 1, 11, 1, 0), TZ, opts).machine?.name).toBe('A');
    // 1970-01-11 04:00 晚于 03:00 → 排班日算 01-11 → 切到 B
    expect(pickByRotate(machines, atUtc(1970, 1, 11, 4, 0), TZ, opts).machine?.name).toBe('B');
  });

  it('支持各机器值班天数不同（A3 / B7 混合）', () => {
    const mixed = [
      machine(1, 'A', '1.1.1.1', { days: 3 }),
      machine(2, 'B', '2.2.2.2', { days: 7 }),
    ];
    const o = { anchorDate: '1970-01-01', switchTime: '03:00' };
    expect(pickByRotate(mixed, atUtc(1970, 1, 1, 12), TZ, o).machine?.name).toBe('A');
    expect(pickByRotate(mixed, atUtc(1970, 1, 3, 12), TZ, o).machine?.name).toBe('A');
    expect(pickByRotate(mixed, atUtc(1970, 1, 4, 12), TZ, o).machine?.name).toBe('B');
    expect(pickByRotate(mixed, atUtc(1970, 1, 10, 12), TZ, o).machine?.name).toBe('B');
    // 第 11 天回到 A（周期 10 天）
    expect(pickByRotate(mixed, atUtc(1970, 1, 11, 12), TZ, o).machine?.name).toBe('A');
  });

  it('基准日在未来（负偏移）也能正确取模，不会崩', () => {
    const o = { anchorDate: '2030-01-01', switchTime: '03:00' };
    const r = pickByRotate(machines, atUtc(2026, 9, 28, 12), TZ, o);
    expect(r.machine).not.toBeNull();
    expect(['A', 'B', 'C']).toContain(r.machine!.name);
  });

  it('anchorDate 非法时回退到 1970-01-01', () => {
    const o = { anchorDate: 'not-a-date', switchTime: '03:00' };
    expect(pickByRotate(machines, atUtc(1970, 1, 1, 12), TZ, o).machine?.name).toBe('A');
  });
});

describe('pickActiveMachine 模式分发', () => {
  it('static 取排序首台', () => {
    const list = [machine(2, 'B', '2.2.2.2'), machine(1, 'A', '1.1.1.1')];
    expect(pickActiveMachine('static', list, 0, TZ, { anchorDate: '1970-01-01', switchTime: '03:00' }).machine?.name).toBe('A');
  });
  it('未识别的模式按 static 处理', () => {
    const list = [machine(1, 'A', '1.1.1.1')];
    expect(pickActiveMachine('whatever', list, 0, TZ, { anchorDate: '1970-01-01', switchTime: '03:00' }).machine?.name).toBe('A');
  });
  it('没有可用机器时返回 null 且带原因', () => {
    const r = pickActiveMachine('rotate', [], 0, TZ, { anchorDate: '1970-01-01', switchTime: '03:00' });
    expect(r.machine).toBeNull();
    expect(r.reason).toContain('没有可用');
  });
});

describe('previewRotate 预览', () => {
  it('按天输出轮转顺序', () => {
    const machines = [
      machine(1, 'A', '1.1.1.1', { days: 1 }),
      machine(2, 'B', '2.2.2.2', { days: 1 }),
    ];
    const rows = previewRotate(machines, atUtc(1970, 1, 1, 0), 4, TZ, { anchorDate: '1970-01-01', switchTime: '03:00' });
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.machineName)).toEqual(['A', 'B', 'A', 'B']);
    expect(rows[0].date).toBe('1970-01-01');
  });
});

describe('splitAnchorAt 解析基准时间', () => {
  it('解析 "YYYY-MM-DD HH:MM"', () => {
    expect(splitAnchorAt('2026-09-20 03:00')).toEqual({ date: '2026-09-20', hm: '03:00' });
  });
  it('兼容 T 分隔与纯日期', () => {
    expect(splitAnchorAt('2026-09-20T08:30')).toEqual({ date: '2026-09-20', hm: '08:30' });
    expect(splitAnchorAt('2026-09-20')).toEqual({ date: '2026-09-20', hm: '' });
  });
  it('非法值返回空', () => {
    expect(splitAnchorAt('nope')).toEqual({ date: '', hm: '' });
    expect(splitAnchorAt('')).toEqual({ date: '', hm: '' });
  });
});

describe('interval 模式：基准时间 + 每 N 天', () => {
  // 三台各 5 天，基准时间 2026-09-20 03:00，15 天一循环
  const machines = [
    machine(1, 'SG', '1.1.1.1', { days: 5 }),
    machine(2, 'KR', '2.2.2.2', { days: 5 }),
    machine(3, 'HK', '3.3.3.3', { days: 5 }),
  ];
  const opts = { anchorAt: '2026-09-20 03:00' };

  it('基准日当天由第一台值班', () => {
    expect(pickByInterval(machines, atUtc(2026, 9, 20, 12), TZ, opts).machine?.name).toBe('SG');
  });

  it('第 5 天仍是第一台，第 6 天切到第二台', () => {
    expect(pickByInterval(machines, atUtc(2026, 9, 24, 12), TZ, opts).machine?.name).toBe('SG');
    expect(pickByInterval(machines, atUtc(2026, 9, 25, 12), TZ, opts).machine?.name).toBe('KR');
  });

  it('第 11 天切到第三台，第 16 天回到第一台', () => {
    expect(pickByInterval(machines, atUtc(2026, 9, 30, 12), TZ, opts).machine?.name).toBe('HK');
    expect(pickByInterval(machines, atUtc(2026, 10, 5, 12), TZ, opts).machine?.name).toBe('SG');
  });

  it('基准时间早于当天切换时刻时，仍算前一天（与 rotate 一致）', () => {
    // 2026-09-25 01:00 早于 03:00 → 排班日回退到 09-24（第 5 天）→ 仍是 SG
    expect(pickByInterval(machines, atUtc(2026, 9, 25, 1, 0), TZ, opts).machine?.name).toBe('SG');
    // 2026-09-25 04:00 → 切到 KR
    expect(pickByInterval(machines, atUtc(2026, 9, 25, 4, 0), TZ, opts).machine?.name).toBe('KR');
  });

  it('reason 文案标明「按基准时间轮转」', () => {
    expect(pickByInterval(machines, atUtc(2026, 9, 20, 12), TZ, opts).reason).toContain('按基准时间轮转');
  });

  it('基准时间缺失时回退到 1970-01-01 且不崩', () => {
    const r = pickByInterval(machines, atUtc(2026, 9, 20, 12), TZ, { anchorAt: '' });
    expect(r.machine).not.toBeNull();
    expect(['SG', 'KR', 'HK']).toContain(r.machine!.name);
  });

  it('没有可用机器时返回 null', () => {
    expect(pickByInterval([], atUtc(2026, 9, 20, 12), TZ, opts).machine).toBeNull();
  });

  it('pickActiveMachine 正确分发 interval', () => {
    const r = pickActiveMachine('interval', machines, atUtc(2026, 9, 20, 12), TZ, {
      anchorDate: '1970-01-01', switchTime: '03:00', anchorAt: '2026-09-20 03:00',
    });
    expect(r.machine?.name).toBe('SG');
  });

  it('previewRotate 支持 interval 模式', () => {
    const rows = previewRotate(machines, atUtc(2026, 9, 20, 0), 3, TZ, { anchorDate: '1970-01-01', switchTime: '03:00', anchorAt: '2026-09-20 03:00' }, 'interval');
    expect(rows.map((x) => x.machineName)).toEqual(['SG', 'SG', 'SG']);
  });
});
