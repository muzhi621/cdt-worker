// 时区与调度窗口纯函数单测
import { describe, it, expect } from 'vitest';
import { dueWithin, inTimeRange, localCycle, toZone, zoneFields } from '../src/engine/time';

describe('dueWithin（定时开关机 2 小时窗口）', () => {
  const WINDOW = 2 * 60 * 60 * 1000;

  it('当天窗口内命中（如配置 08:00，现在 08:30）', () => {
    const now = new Date(2026, 8, 26, 8, 30);
    expect(dueWithin(now, '08:00', WINDOW)).toBe(true);
  });

  it('窗口边界：配置时间之前不命中；2 小时整压线命中，之后不命中', () => {
    expect(dueWithin(new Date(2026, 8, 26, 7, 59), '08:00', WINDOW)).toBe(false);
    expect(dueWithin(new Date(2026, 8, 26, 8, 0), '08:00', WINDOW)).toBe(true);
    expect(dueWithin(new Date(2026, 8, 26, 10, 0), '08:00', WINDOW)).toBe(true);
    expect(dueWithin(new Date(2026, 8, 26, 10, 1), '08:00', WINDOW)).toBe(false);
  });

  it('跨午夜窗口：配置 23:00，次日凌晨 00:30 仍命中（昨天窗口延续）', () => {
    const now = new Date(2026, 8, 27, 0, 30);
    expect(dueWithin(now, '23:00', WINDOW)).toBe(true);
  });

  it('跨午夜窗口：凌晨 01:00 压线命中、01:01 起不命中', () => {
    expect(dueWithin(new Date(2026, 8, 27, 1, 0), '23:00', WINDOW)).toBe(true);
    expect(dueWithin(new Date(2026, 8, 27, 1, 1), '23:00', WINDOW)).toBe(false);
  });

  it('非法输入返回 false', () => {
    expect(dueWithin(new Date(2026, 8, 26, 8, 0), '', WINDOW)).toBe(false);
    expect(dueWithin(new Date(2026, 8, 26, 8, 0), 'abc', WINDOW)).toBe(false);
    expect(dueWithin(new Date(2026, 8, 26, 8, 0), '8:xx', WINDOW)).toBe(false);
  });
});

describe('inTimeRange（保活时段，支持跨午夜区间）', () => {
  it('普通区间', () => {
    expect(inTimeRange('10:00', '08:00', '23:00')).toBe(true);
    expect(inTimeRange('07:59', '08:00', '23:00')).toBe(false);
    expect(inTimeRange('23:00', '08:00', '23:00')).toBe(false); // 右开区间
  });

  it('跨午夜区间（22:00–06:00）', () => {
    expect(inTimeRange('23:30', '22:00', '06:00')).toBe(true);
    expect(inTimeRange('05:59', '22:00', '06:00')).toBe(true);
    expect(inTimeRange('12:00', '22:00', '06:00')).toBe(false);
  });

  it('空配置返回 false', () => {
    expect(inTimeRange('10:00', '', '23:00')).toBe(false);
  });
});

describe('toZone / zoneFields / localCycle（时区墙钟）', () => {
  it('UTC 时间转换到 Asia/Shanghai 加 8 小时', () => {
    // 2026-09-26T20:00:00Z → 上海 2026-09-27 04:00
    const utc = new Date('2026-09-26T20:00:00Z');
    const f = zoneFields(utc, 'Asia/Shanghai');
    expect([f.month, f.day, f.hour]).toEqual([9, 27, 4]);
  });

  it('localCycle 用配置时区账期，UTC 月初 8 小时内不错位', () => {
    // UTC 2026-03-01 02:00 = 上海 2026-03-01 10:00 → 账期 2026-03
    expect(localCycle(new Date('2026-03-01T02:00:00Z'), 'Asia/Shanghai')).toBe('2026-03');
    // UTC 2026-02-28 20:00 = 上海 2026-03-01 04:00 → 账期已进入 3 月
    expect(localCycle(new Date('2026-02-28T20:00:00Z'), 'Asia/Shanghai')).toBe('2026-03');
    // 纽约时区同一时刻仍是 2 月
    expect(localCycle(new Date('2026-02-28T20:00:00Z'), 'America/New_York')).toBe('2026-02');
  });

  it('toZone 产出的 Date 墙钟值等于目标时区本地时间', () => {
    const utc = new Date('2026-09-26T16:30:00Z'); // 上海 00:30
    const local = toZone(utc, 'Asia/Shanghai');
    expect(local.getUTCHours()).toBe(0);
    expect(local.getUTCMinutes()).toBe(30);
    expect(local.getUTCDate()).toBe(27);
  });

  it('非法时区回退不崩溃', () => {
    const utc = new Date('2026-09-26T16:30:00Z');
    expect(() => zoneFields(utc, 'Not/AZone')).not.toThrow();
  });
});
