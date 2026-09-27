// 时间与时区纯函数：供 engine 调度判断使用，也可独立单测（无 D1 / cloudflare 依赖）

// 把 Date 转换到配置时区，返回一个"墙钟数值等于目标时区本地时间"的 Date。
// Worker 运行时是 UTC，原项目用 time.LoadLocation(config.Timezone) 计算本地时间；
// 供 dueWithin（定时开关机）使用。整点/保活时段/账单月份用 zoneFields 直接取字段。
// Intl.DateTimeFormat 构造成本很高（毫秒级）。Worker 免费计划 CPU 上限 10ms/请求，
// 而每轮监控会产生 20–30 次时区格式化调用（toZone / zoneFields / localCycle × 账号数），
// 因此这里按时区缓存格式化器实例（isolate 内复用）。
const formatterCache = new Map<string, Intl.DateTimeFormat>();
const FIELD_OPTS: Intl.DateTimeFormatOptions = {
  hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
};

function formatter(timezone: string): Intl.DateTimeFormat {
  const tz = timezone || 'Asia/Shanghai';
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { ...FIELD_OPTS, timeZone: tz });
    formatterCache.set(tz, f);
  }
  return f;
}

// 解析格式化结果到字段（跨 Intl 版本差异兜底：取不到就回退 UTC 字段）
function partsToFields(parts: Intl.DateTimeFormatPart[], fallback: Date): {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
} {
  const g: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') g[p.type] = parseInt(p.value, 10);
  return {
    year: g.year ?? fallback.getUTCFullYear(),
    month: g.month ?? fallback.getUTCMonth() + 1,
    day: g.day ?? fallback.getUTCDate(),
    hour: g.hour ?? 0,
    minute: g.minute ?? 0,
    second: g.second ?? 0,
  };
}

export function toZone(date: Date, timezone: string): Date {
  try {
    const parts = formatter(timezone).formatToParts(date);
    const f = partsToFields(parts, date);
    const asUTC = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
    return new Date(asUTC);
  } catch {
    return date; // 时区非法时回退到 UTC（与原项目 FixedZone CST 回退语义等价，均保证不崩溃）
  }
}

// 以目标时区的“墙钟字符串”形式输出（YYYY-MM-DD HH:mm:ss）。
// 日志列表/API 展示专用：复用上面同一个 formatter 缓存，避免每条日志 new Intl.DateTimeFormat。
export function formatWallClock(date: Date, timezone: string): string {
  try {
    const f = partsToFields(formatter(timezone).formatToParts(date), date);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${f.year}-${p(f.month)}-${p(f.day)} ${p(f.hour)}:${p(f.minute)}:${p(f.second)}`;
  } catch {
    return date.toISOString().slice(0, 19).replace('T', ' ');
  }
}

// 以目标时区的“墙钟字符串”形式获取当前时间字段（YYYY-MM-DD HH:mm:ss）
export function zoneFields(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  try {
    return partsToFields(formatter(timezone).formatToParts(date), date);
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

// 配置时刻 + 容忍窗口是否已过（通用判定，分钟比较）：供「错过窗口补偿」使用。
// 补偿关机与补偿开机共用：now 的墙钟分钟 > time + 窗口时长 → 窗口已彻底错过。
export function windowOver(fields: { hour: number; minute: number }, time: string, windowMs: number): boolean {
  const [h, m] = time.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return false;
  const targetMin = h * 60 + m;
  const nowMin = fields.hour * 60 + fields.minute;
  return nowMin > targetMin + Math.floor(windowMs / 60000);
}

// 关机窗口是否已结束（同一天内）：now 的墙钟分钟 > stopTime + 窗口时长。
// 供「错过窗口补偿」使用——只在关机窗口结束后的当天补执行，跨天后不再追溯
//（隔天仍 Running 的实例属于手动/保活意图，不强行关回）。
export function stopWindowOver(fields: { hour: number; minute: number }, stopTime: string, windowMs: number): boolean {
  return windowOver(fields, stopTime, windowMs);
}
