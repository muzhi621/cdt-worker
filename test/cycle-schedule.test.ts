// 「基准时间 + N 天循环开关机」相位判定单测（纯函数，无 D1 / cloudflare 依赖）
import { describe, it, expect } from 'vitest';
import { cyclePhase } from '../src/engine/time';

const TZ = 'Asia/Shanghai'; // UTC+8

// 便于书写：给定上海墙钟时间，返回对应的 UTC Date（上海 = UTC+8，无夏令时）
function sh(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi, 0));
}

describe('cyclePhase（基准时间 + N 天循环开关机）', () => {
  const anchor = '2026-09-30 00:00:00';

  it('早于基准时间 → started=false，不动作', () => {
    const p = cyclePhase(sh(2026, 9, 29, 23, 59), TZ, anchor, 10);
    expect(p.started).toBe(false);
    expect(p.on).toBe(false);
  });

  it('到达基准时间 → 进入第 1 相位（开机）', () => {
    const p = cyclePhase(sh(2026, 9, 30, 0, 0), TZ, anchor, 10);
    expect(p.started).toBe(true);
    expect(p.on).toBe(true);
    expect(p.boundaryDate).toBe('2026-09-30');
    expect(p.boundaryKey).toBe('20260930');
    expect(p.phaseDay).toBe(1);
  });

  it('首个 N 天末尾仍在开机相位（第 10 天）', () => {
    const p = cyclePhase(sh(2026, 10, 9, 23, 59), TZ, anchor, 10);
    expect(p.started).toBe(true);
    expect(p.on).toBe(true);
    expect(p.phaseDay).toBe(10);
    expect(p.boundaryDate).toBe('2026-09-30');
  });

  it('第 2 个 N 天起切换为关机相位', () => {
    const p = cyclePhase(sh(2026, 10, 10, 0, 0), TZ, anchor, 10);
    expect(p.on).toBe(false);
    expect(p.boundaryDate).toBe('2026-10-10');
    expect(p.phaseDay).toBe(1);
  });

  it('第 3 个 N 天再切回开机相位（交替）', () => {
    const p = cyclePhase(sh(2026, 10, 20, 0, 0), TZ, anchor, 10);
    expect(p.on).toBe(true);
    expect(p.boundaryDate).toBe('2026-10-20');
  });

  it('基准时刻非午夜时，切换发生在「基准时刻」而非当天零点', () => {
    const a3 = '2026-09-30 03:00:00';
    // 10-10 02:00（早于 03:00）→ 仍算前一天，处于开机相位第 10 天
    const before = cyclePhase(sh(2026, 10, 10, 2, 0), TZ, a3, 10);
    expect(before.on).toBe(true);
    expect(before.phaseDay).toBe(10);
    // 10-10 03:00 → 切换为关机相位
    const at = cyclePhase(sh(2026, 10, 10, 3, 0), TZ, a3, 10);
    expect(at.on).toBe(false);
    expect(at.boundaryDate).toBe('2026-10-10');
  });

  it('N=1 时逐日交替', () => {
    expect(cyclePhase(sh(2026, 9, 30, 12, 0), TZ, anchor, 1).on).toBe(true);
    expect(cyclePhase(sh(2026, 10, 1, 12, 0), TZ, anchor, 1).on).toBe(false);
    expect(cyclePhase(sh(2026, 10, 2, 12, 0), TZ, anchor, 1).on).toBe(true);
  });

  it('兼容 datetime-local 的 "T" 分隔与秒（前端传入格式）', () => {
    const p = cyclePhase(sh(2026, 9, 30, 1, 0), TZ, '2026-09-30T00:00:00', 10);
    expect(p.started).toBe(true);
    expect(p.on).toBe(true);
  });

  it('非法输入一律返回未开始（不崩溃）', () => {
    const now = sh(2026, 10, 5, 12, 0);
    expect(cyclePhase(now, TZ, '', 10).started).toBe(false);
    expect(cyclePhase(now, TZ, 'garbage', 10).started).toBe(false);
    expect(cyclePhase(now, TZ, anchor, 0).started).toBe(false);
    expect(cyclePhase(now, TZ, anchor, -5).started).toBe(false);
    expect(cyclePhase(now, TZ, anchor, NaN).started).toBe(false);
  });

  it('时区影响：同一 UTC 时刻在不同时区可能处于不同相位', () => {
    // UTC 2026-10-09T16:00 = 上海 10-10 00:00（已切换关机）；UTC 仍是 10-09（开机末段）
    const utc = new Date('2026-10-09T16:00:00Z');
    expect(cyclePhase(utc, 'Asia/Shanghai', anchor, 10).on).toBe(false);
    expect(cyclePhase(utc, 'UTC', anchor, 10).on).toBe(true);
  });
});
