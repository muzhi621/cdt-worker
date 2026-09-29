// 「基准时间 + N 天循环开关机」按时性验证：按外部 cron 的真实节拍推进时间，
// 检查相位切换是否被及时捕捉、是否会重复下发、断档后能否补上。
import { describe, it, expect } from 'vitest';
import { cyclePhase } from '../src/engine/time';

const TZ = 'Asia/Shanghai'; // UTC+8

// 上海墙钟 → UTC Date
function sh(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h - 8, mi, 0));
}

interface Tick { t: Date; started: boolean; on: boolean; boundary: string; }

// 模拟 cron 节拍：从 start 起每 stepMin 分钟触发一次，直到 end（含）
function simulate(
  start: Date,
  end: Date,
  stepMin: number,
  anchor: string,
  days: number,
  startOn = true,
  gap?: { from: Date; to: Date }, // 模拟 cron 断档（from~to 之间不触发）
): Tick[] {
  const ticks: Tick[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += stepMin * 60_000) {
    const d = new Date(t);
    if (gap && d.getTime() >= gap.from.getTime() && d.getTime() <= gap.to.getTime()) continue;
    const p = cyclePhase(d, TZ, anchor, days, startOn);
    ticks.push({ t: d, started: p.started, on: p.on, boundary: p.boundaryDate });
  }
  return ticks;
}

// 相位翻转点：相邻两次触发中 on 发生变化的时刻（即引擎会下发指令的时刻）
function flips(ticks: Tick[]): Tick[] {
  const out: Tick[] = [];
  for (let i = 1; i < ticks.length; i++) {
    if (ticks[i].started && ticks[i - 1].started && ticks[i].on !== ticks[i - 1].on) out.push(ticks[i]);
    else if (ticks[i].started && !ticks[i - 1].started) out.push(ticks[i]); // 基准时间到达即为首次动作点
  }
  return out;
}

describe('循环开关机 · 按时性（cron 节拍仿真）', () => {
  const anchor = '2026-09-30 00:00:00';

  it('基准时间之前永不触发；到达后首个节拍即进入开机相位', () => {
    const ticks = simulate(sh(2026, 9, 29, 0, 0), sh(2026, 9, 30, 12, 0), 30, anchor, 10);
    const before = ticks.filter((t) => t.t.getTime() < sh(2026, 9, 30, 0, 0).getTime());
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((t) => !t.started)).toBe(true); // 早于基准：一律不动
    const first = ticks.find((t) => t.started)!;
    expect(first.t.getTime()).toBe(sh(2026, 9, 30, 0, 0).getTime());
    expect(first.on).toBe(true);
  });

  it('每 N 天翻转一次，落点正好是基准时刻（30 分钟节拍下误差 ≤ 一个节拍）', () => {
    const ticks = simulate(sh(2026, 9, 29, 18, 0), sh(2026, 10, 25, 0, 0), 30, anchor, 10);
    const fs = flips(ticks);
    // 09-30 开机 → 10-10 关机 → 10-20 开机，共 3 个动作点
    expect(fs.map((f) => f.t.getTime())).toEqual([
      sh(2026, 9, 30, 0, 0).getTime(),
      sh(2026, 10, 10, 0, 0).getTime(),
      sh(2026, 10, 20, 0, 0).getTime(),
    ]);
    expect(fs.map((f) => f.on)).toEqual([true, false, true]);
    expect(fs.map((f) => f.boundary)).toEqual(['2026-09-30', '2026-10-10', '2026-10-20']);
  });

  it('节拍再粗（每小时一次）也只会晚不到一个节拍，不会错过整段相位', () => {
    const ticks = simulate(sh(2026, 10, 9, 20, 0), sh(2026, 10, 10, 6, 0), 60, anchor, 10);
    const firstOff = ticks.find((t) => !t.on)!;
    expect(firstOff.t.getTime()).toBe(sh(2026, 10, 10, 0, 0).getTime()); // 00:00 整点在节拍上
    // 即使节拍错开（如 00:40 才跑），延迟也只有一个节拍
    const skew = simulate(sh(2026, 10, 9, 20, 40), sh(2026, 10, 10, 6, 40), 60, anchor, 10);
    const late = skew.find((t) => !t.on)!;
    expect(late.t.getTime() - sh(2026, 10, 10, 0, 0).getTime()).toBeLessThanOrEqual(60 * 60_000);
  });

  it('相位是持续态：cron 断档一天后恢复，仍能被正确捕捉（不像每日定时依赖 ±2h 窗口）', () => {
    // 断档：10-09 12:00 ~ 10-10 06:00 完全没有触发
    const ticks = simulate(
      sh(2026, 10, 9, 0, 0), sh(2026, 10, 10, 12, 0), 30, anchor, 10,
      true, { from: sh(2026, 10, 9, 12, 0), to: sh(2026, 10, 10, 6, 0) },
    );
    const resumed = ticks.find((t) => t.t.getTime() > sh(2026, 10, 10, 6, 0).getTime())!;
    expect(resumed.started).toBe(true);
    expect(resumed.on).toBe(false); // 恢复后立刻识别为关机相位（相位持续 10 天，不靠窗口命中）
    expect(resumed.boundary).toBe('2026-10-10');
  });

  it('基准时刻非整点时，翻转点跟随该时刻而非当天零点', () => {
    const a3 = '2026-09-30 03:00:00';
    const ticks = simulate(sh(2026, 10, 9, 20, 0), sh(2026, 10, 10, 8, 0), 30, a3, 10);
    const firstOff = ticks.find((t) => !t.on)!;
    expect(firstOff.t.getTime()).toBe(sh(2026, 10, 10, 3, 0).getTime());
  });

  it('初始状态=关机 时，动作点与开机起步完全反相（时序一致）', () => {
    const ticks = simulate(sh(2026, 9, 29, 18, 0), sh(2026, 10, 25, 0, 0), 30, anchor, 10, false);
    const fs = flips(ticks);
    expect(fs.map((f) => f.on)).toEqual([false, true, false]);
    expect(fs.map((f) => f.t.getTime())).toEqual([
      sh(2026, 9, 30, 0, 0).getTime(),
      sh(2026, 10, 10, 0, 0).getTime(),
      sh(2026, 10, 20, 0, 0).getTime(),
    ]);
  });

  it('一整个相位内不会反复触发（同一相位 on 恒定，10 天 × 每 30 分钟 = 480 拍只对应 1 次动作）', () => {
    const ticks = simulate(sh(2026, 9, 30, 0, 0), sh(2026, 10, 9, 23, 30), 30, anchor, 10);
    expect(ticks.length).toBe(480);
    expect(new Set(ticks.map((t) => t.on)).size).toBe(1);
    // 进入相位后不再产生任何新的动作点：配合「相位边界 + 动作」幂等键，整个相位只下发一次
    expect(flips(ticks).length).toBe(0);
    expect(ticks[0].on).toBe(true);
  });
});
