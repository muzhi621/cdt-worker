// DDNS 排班算法（纯函数，不触碰数据库与网络，便于单测）
//
// 两种模式：
//   1) window 按一天内时间段：给每台机器填在线时段（如 08:00-14:00），
//      当前时间落在谁的时段就解析给谁，支持跨天（22:00-06:00）。
//   2) rotate 按天轮转：组内机器按各自「值班天数」轮流，
//      例如 A 10 天 / B 10 天 / C 10 天，30 天一个循环。
//      可设 anchor_date 基准日与 switch_time 切换时刻。
//
// 时区：一律按分组配置的 IANA 时区（如 Asia/Shanghai）判定「当前是几点/哪天」，
// 不用 UTC——否则东八区会在凌晨 8 小时的时间差上错位一整天。

export interface DdnsMachine {
  id: number;
  name: string;
  ip: string;
  enabled: boolean;
  sortOrder: number;
  // rotate 模式：本台机器连续值班的天数（>=1）
  days: number;
  // window 模式：在线时段 HH:MM，空串表示未配置
  windowStart: string;
  windowEnd: string;
}

export interface RotateOptions {
  /** 基准日 YYYY-MM-DD，轮换周期从这天开始算 */
  anchorDate: string;
  /** 每天切换时刻 HH:MM，早于该时刻仍算「前一天」的值班机器 */
  switchTime: string;
}

/** 统一排班参数：rotate 用 anchorDate+switchTime，interval 用 anchorAt */
export interface ScheduleOptions extends RotateOptions {
  /** 基准时间 YYYY-MM-DD HH:MM（interval 模式的轮换起点，含切换时刻） */
  anchorAt?: string;
}

/**
 * 拆出「基准时间」里的日期与时刻。
 * 兼容 "YYYY-MM-DD HH:MM" / "YYYY-MM-DDTHH:MM" / 仅 "YYYY-MM-DD"（缺时刻视为 00:00）。
 */
export function splitAnchorAt(s: string | null | undefined): { date: string; hm: string } {
  const raw = String(s || '').trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?/.exec(raw);
  if (!m) return { date: '', hm: '' };
  return { date: m[1], hm: m[2] || '' };
}

export interface PickResult {
  machine: DdnsMachine | null;
  /** 命中原因，写日志用 */
  reason: string;
}

/** 解析 HH:MM 为当日分钟数（0~1439）；非法返回 null */
export function parseHm(hm: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 解析 YYYY-MM-DD 为 UTC 毫秒时间戳；非法返回 null */
export function parseDate(dateStr: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
}

/** 把 UTC 毫秒时间戳格式化为 YYYY-MM-DD */
export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * 取指定时区下的「日期 + 当日分钟数」。
 * 用 Intl 而非手工加减偏移：夏令时/半小时时区靠硬编码偏移一定出错。
 */
export function zonedParts(ms: number, timeZone: string): { date: string; minutes: number } {
  let date = formatDate(ms);
  let minutes = 0;
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    const parts = fmt.formatToParts(new Date(ms));
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
    const y = get('year'), mo = get('month'), d = get('day');
    let h = Number(get('hour'));
    const mi = Number(get('minute'));
    if (y && mo && d) date = `${y}-${mo}-${d}`;
    // Intl 在部分运行时会把午夜给成 24:00，归一到 0
    if (h === 24) h = 0;
    minutes = h * 60 + mi;
  } catch {
    // 时区非法时退回 UTC，保证不抛异常中断整轮同步
    const d = new Date(ms);
    minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  }
  return { date, minutes };
}

/** 参与排班的机器：启用 + IP 非空，按 sortOrder 稳定排序 */
function activeSorted(machines: DdnsMachine[]): DdnsMachine[] {
  return machines
    .filter((m) => m.enabled && String(m.ip || '').trim() !== '')
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

/**
 * window 模式：按一天内时间段命中。
 * 支持跨天（start > end，如 22:00-06:00 → 命中 22:00~23:59 或 00:00~05:59）。
 */
export function pickByWindow(
  machines: DdnsMachine[],
  nowMs: number,
  timeZone: string,
): PickResult {
  const list = activeSorted(machines);
  if (list.length === 0) return { machine: null, reason: '组内没有可用的机器' };
  const { minutes } = zonedParts(nowMs, timeZone);

  for (const m of list) {
    const start = parseHm(m.windowStart);
    const end = parseHm(m.windowEnd);
    // 任一端缺失视为该机器未配置时段，跳过（不算命中）
    if (start === null || end === null) continue;
    const hit = start <= end
      ? (minutes >= start && minutes < end)
      : (minutes >= start || minutes < end); // 跨天
    if (hit) {
      return { machine: m, reason: `当前时间落在「${m.name}」的时段 ${m.windowStart}-${m.windowEnd}` };
    }
  }
  return { machine: null, reason: '当前时间没有任何机器的时段命中' };
}

/**
 * rotate 模式：按「值班天数」轮转。
 *
 * - 以 anchorDate 为周期原点；未配置或非法则回退 1970-01-01。
 * - switchTime 之前仍算前一天：避免 03:00 切换时与用户的开机时间错位
 *   （机器 08:00 才起来，若凌晨 00:00 就切解析，会有几小时解析到关机机器）。
 * - 每台机器 days 可不同（A 10 / B 10 / C 10 → 30 天循环；想按月就填 30）。
 */
export function pickByRotate(
  machines: DdnsMachine[],
  nowMs: number,
  timeZone: string,
  opts: RotateOptions,
): PickResult {
  const list = activeSorted(machines);
  if (list.length === 0) return { machine: null, reason: '组内没有可用的机器' };

  const { date, minutes } = zonedParts(nowMs, timeZone);
  const switchMin = parseHm(opts.switchTime) ?? 180; // 默认 03:00

  // 排班日：早于切换时刻 → 仍用「昨天」的排班结果
  const todayMs = parseDate(date);
  const dutyMs = (todayMs ?? nowMs) - (minutes < switchMin ? 86400000 : 0);

  const anchorMs = parseDate(opts.anchorDate);
  const base = anchorMs ?? 0;

  const offsetDays = Math.floor((dutyMs - base) / 86400000);

  // 总周期 = 各机器值班天数之和；至少 1，避免除零
  const daysList = list.map((m) => Math.max(1, Math.floor(m.days) || 1));
  const period = daysList.reduce((a, b) => a + b, 0) || 1;

  // 取模并归一到正数：offsetDays 可能为负（anchor 在未来或排班日回退到昨天）
  const pos = ((offsetDays % period) + period) % period;

  let acc = 0;
  for (let i = 0; i < list.length; i++) {
    acc += daysList[i];
    if (pos < acc) {
      const m = list[i];
      return {
        machine: m,
        reason: `按天轮转命中「${m.name}」（周期 ${period} 天，第 ${pos + 1} 天，值班 ${daysList[i]} 天，基准日 ${formatDate(base)}）`,
      };
    }
  }
  // 理论上不可达（pos 一定落在某个区间内），兜底返回首台
  return { machine: list[0], reason: '按天轮转兜底取首台机器' };
}

/**
 * interval 模式：「基准时间 + 每 N 天」轮换。
 *
 * 与 rotate 共用「每台机器值班天数（各自 N）」的轮转内核，区别在于轮换原点是一
 * 个精确到分钟的**基准时间**（anchorAt），而不是「基准日 + 每日切换时刻」两段式。
 * 适合「从某个时刻起，每台机器各跑 N 天」的简单心智。
 */
export function pickByInterval(
  machines: DdnsMachine[],
  nowMs: number,
  timeZone: string,
  opts: { anchorAt?: string },
): PickResult {
  const list = activeSorted(machines);
  if (list.length === 0) return { machine: null, reason: '组内没有可用的机器' };
  const { date, hm } = splitAnchorAt(opts.anchorAt);
  const res = pickByRotate(machines, nowMs, timeZone, {
    anchorDate: date || '1970-01-01',
    switchTime: hm || '00:00',
  });
  if (!res.machine) return res;
  return { machine: res.machine, reason: res.reason.replace(/^按天轮转/, '按基准时间轮转') };
}

/**
 * 统一入口：按分组模式选择值班机器。
 * static 模式（固定首台）也走这里，取 sortOrder 最小的可用机器。
 */
export function pickActiveMachine(
  mode: string,
  machines: DdnsMachine[],
  nowMs: number,
  timeZone: string,
  opts: ScheduleOptions,
): PickResult {
  if (mode === 'window') return pickByWindow(machines, nowMs, timeZone);
  if (mode === 'rotate') return pickByRotate(machines, nowMs, timeZone, opts);
  if (mode === 'interval') return pickByInterval(machines, nowMs, timeZone, { anchorAt: opts.anchorAt });
  // static 或未识别的模式：固定首台
  const list = activeSorted(machines);
  return list.length
    ? { machine: list[0], reason: '固定首台机器' }
    : { machine: null, reason: '组内没有可用的机器' };
}

/**
 * 预览未来若干天的排班（每天一行，按 switchTime 之后的时刻取样）。
 * 供前端「预览」与排错用：能一眼看出轮转顺序是否符合预期。
 */
export function previewRotate(
  machines: DdnsMachine[],
  startMs: number,
  days: number,
  timeZone: string,
  opts: ScheduleOptions,
  mode = 'rotate',
): { date: string; machineName: string; ip: string }[] {
  const out: { date: string; machineName: string; ip: string }[] = [];
  const dayMs = 86400000;
  const pick = (ms: number): PickResult => (mode === 'interval'
    ? pickByInterval(machines, ms, timeZone, { anchorAt: opts.anchorAt })
    : pickByRotate(machines, ms, timeZone, opts));
  // 取样时刻取「切换时刻之后 1 分钟」，确保取到的是当天的新排班而非前一天残留
  const switchMin = mode === 'interval'
    ? (parseHm(splitAnchorAt(opts.anchorAt).hm) ?? 0)
    : (parseHm(opts.switchTime) ?? 180);
  // 取样点必须按**目标时区**的本地日计算。
  // 旧写法是「UTC 日起点 + 切换分钟」：东八区下等价于北京时间 08:01 取样、日期标签却取 UTC 日，
  // 整张预览表会与真实排班错开一天（预览是给人核对轮转顺序的，错一天反而更难排查）。
  // 做法：先求 startMs 在本地时区的**当日 00:00** 所对应的 UTC 毫秒，再按天推进，
  // 取样取本地切换时刻之后 1 分钟；日期标签直接取该取样点的本地日期，保证标签与取样同源。
  const { minutes: startMinutes } = zonedParts(startMs, timeZone);
  const day0Utc = startMs - startMinutes * 60000;
  for (let i = 0; i < days; i++) {
    // +24h 在夏令时切换日会落在本日 01:00 或 23:00，但取样时刻在切换点之后、
    // 日期标签又取自取样点自身，故不会串日（最坏只是当天取样点偏移 1 小时）。
    const sampleMs = day0Utc + i * dayMs + (switchMin + 1) * 60000;
    const r = pick(sampleMs);
    const { date } = zonedParts(sampleMs, timeZone);
    out.push({
      date,
      machineName: r.machine ? r.machine.name : '(无)',
      ip: r.machine ? r.machine.ip : '',
    });
  }
  return out;
}
