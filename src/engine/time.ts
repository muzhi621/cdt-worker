// 时间与时区纯函数：供 engine 调度判断使用，也可独立单测（无 D1 / cloudflare 依赖）

// 把 Date 转换到配置时区，返回一个"墙钟数值等于目标时区本地时间"的 Date。
// Worker 运行时是 UTC，原项目用 time.LoadLocation(config.Timezone) 计算本地时间；
// 供 dueWithin（定时开关机）使用。整点/保活时段/账单月份用 zoneFields 直接取字段。
export function toZone(date: Date, timezone: string): Date {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'Asia/Shanghai',
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date);
    const g: Record<string, number> = {};
    for (const p of parts) if (p.type !== 'literal') g[p.type] = parseInt(p.value, 10);
    const asUTC = Date.UTC(g.year, (g.month || 1) - 1, g.day, g.hour, g.minute, g.second);
    return new Date(asUTC);
  } catch {
    return date; // 时区非法时回退到 UTC（与原项目 FixedZone CST 回退语义等价，均保证不崩溃）
  }
}

// 以目标时区的“墙钟字符串”形式获取当前时间字段（YYYY-MM-DD HH:mm:ss）
export function zoneFields(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'Asia/Shanghai', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date);
    const g: Record<string, number> = {};
    for (const p of parts) if (p.type !== 'literal') g[p.type] = parseInt(p.value, 10);
    return { year: g.year, month: g.month || 1, day: g.day, hour: g.hour || 0, minute: g.minute || 0, second: g.second || 0 };
  } catch {
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
  }
}

// 以配置时区的年月作为账单账期（YYYY-MM），与日志/通知/定时一致。
// 不能用 UTC 月份（toISOString().slice(0,7)），否则每月月初/月末 8 小时账单月份错位。
export function localCycle(now: Date, timezone: string): string {
  const f = zoneFields(now, timezone);
  return `${f.year}-${String(f.month).padStart(2, '0')}`;
}

// 定时开关机命中窗口判断：now 为配置时区的“墙钟 Date”（由 toZone 产出），
// hhmm 为 "HH:mm" 配置时间，windowMs 为容忍窗口（当前 2 小时）。
// 跨午夜窗口：若 target 在今天（墙钟）而 now 已过午夜（delta < 0），
// 把 target 回拨 24h 再判断，使 2 小时窗口能正确跨越午夜（如 23:00 覆盖到次日 01:00）。
export function dueWithin(now: Date, hhmm: string, windowMs: number): boolean {
  if (!hhmm) return false;
  const [h, m] = hhmm.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return false;
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  let delta = now.getTime() - target.getTime();
  if (delta < 0) {
    delta += 24 * 3600 * 1000;
    if (delta <= windowMs) return true;
    return false;
  }
  return delta <= windowMs;
}

// 保活时段判断：start/end 为 "HH:mm"；start > end 表示跨午夜区间（如 22:00–06:00）
export function inTimeRange(current: string, start: string, end: string): boolean {
  if (!start || !end) return false;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}
