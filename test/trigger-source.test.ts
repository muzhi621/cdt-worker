// 触发源（渠道开关 / 来源识别 / 断档判定）单测
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRIGGER_SOURCES, isSourceStale, normalizeSource,
  parseTriggerSeen, parseTriggerSources, shouldNativeRun, TRIGGER_GAP_THRESHOLD_SEC,
} from '../src/engine/triggers';

describe('normalizeSource（来源识别）', () => {
  it('显式声明的渠道', () => {
    expect(normalizeSource('github')).toBe('github');
    expect(normalizeSource('GitHub_Actions')).toBe('github');
    expect(normalizeSource('selfhost')).toBe('selfhost');
    expect(normalizeSource('driver')).toBe('selfhost');
    expect(normalizeSource('http')).toBe('http');
  });

  it('原生 Cron 的历史别名 cron / scheduled 归回 native', () => {
    expect(normalizeSource('native')).toBe('native');
    expect(normalizeSource('cron')).toBe('native');
    expect(normalizeSource('scheduled')).toBe('native');
  });

  it('未声明/未知值归为 http（兼容 cron-job.org 等既有配置）', () => {
    expect(normalizeSource(null)).toBe('http');
    expect(normalizeSource('')).toBe('http');
    expect(normalizeSource('unknown-thing')).toBe('http');
  });
});

describe('parseTriggerSources / parseTriggerSeen（配置解析）', () => {
  it('空值与非法 JSON 回退默认，不抛异常', () => {
    expect(parseTriggerSources(null)).toEqual(DEFAULT_TRIGGER_SOURCES);
    expect(parseTriggerSources('')).toEqual(DEFAULT_TRIGGER_SOURCES);
    expect(() => parseTriggerSources('{oops')).not.toThrow();
    expect(parseTriggerSources('{oops')).toEqual(DEFAULT_TRIGGER_SOURCES);
  });

  it('只接受布尔值，缺失项用默认补齐', () => {
    const parsed = parseTriggerSources('{"github":false,"selfhost":true,"tencent":"yes"}');
    expect(parsed.github).toBe(false);
    expect(parsed.selfhost).toBe(true);
    expect(parsed.http).toBe(DEFAULT_TRIGGER_SOURCES.http);
  });

  it('原生 Cron 默认开启，GitHub 与外部定时默认关闭（自建驱动保留）', () => {
    expect(DEFAULT_TRIGGER_SOURCES.native).toBe(true);
    expect(DEFAULT_TRIGGER_SOURCES.github).toBe(false);
    expect(DEFAULT_TRIGGER_SOURCES.http).toBe(false);
    expect(DEFAULT_TRIGGER_SOURCES.selfhost).toBe(true);
  });

  it('存量数据里的 native 键正常解析，非布尔值回退默认', () => {
    const parsed = parseTriggerSources('{"native":true,"http":false}');
    expect(parsed.native).toBe(true);
    expect(parsed.http).toBe(false);
    expect(parseTriggerSources('{"native":"yes"}').native).toBe(DEFAULT_TRIGGER_SOURCES.native);
  });

  it('trigger_seen 能读出存量的 native 时间戳', () => {
    const seen = parseTriggerSeen('{"native":1700000000,"github":1700000001}');
    expect(seen.native).toBe(1700000000);
    expect(seen.github).toBe(1700000001);
  });

  it('时间戳解析：只保留正数，非法数据返回空', () => {
    expect(parseTriggerSeen('{"github":1700000000,"http":0}')).toEqual({ github: 1700000000 });
    expect(parseTriggerSeen(null)).toEqual({});
    expect(parseTriggerSeen('not-json')).toEqual({});
  });
});

describe('shouldNativeRun（原生 Cron 节流）', () => {
  const now = 1_700_000_000;

  it('间隔为 0 或从未执行过 → 直接跑', () => {
    expect(shouldNativeRun(0, 5, now)).toBe(true);
    expect(shouldNativeRun(0, 0, now)).toBe(true);
    expect(shouldNativeRun(now - 9999, 0, now)).toBe(true);
  });

  it('距上次真实执行不足一个间隔 → 跳过', () => {
    expect(shouldNativeRun(now - 120, 5, now)).toBe(false); // 刚跑过 2 分钟，间隔 5 分钟
    expect(shouldNativeRun(now - 299, 5, now)).toBe(false); // 压线差一秒
  });

  it('达到间隔 → 执行（含压线刚好等于）', () => {
    expect(shouldNativeRun(now - 300, 5, now)).toBe(true);
    expect(shouldNativeRun(now - 900, 15, now)).toBe(true);
  });

  // 锁住「断档告警失效」回归：判定必须基于 lastRun（last_monitor_run，真正抢到槽位的
  // 时刻）。若误用渠道触发时刻，跳过的轮次也会被当成"已触发"写进 trigger_seen，
  // 上次触发时间自我刷新，30 分钟断档阈值永远不会命中，告警形同虚设。
  it('判定基于真实执行时刻 lastRun，不因触发时刻滞后而卡死', () => {
    expect(shouldNativeRun(now - 120, 5, now)).toBe(false);
    expect(shouldNativeRun(now - 120, 5, now + 300)).toBe(true);
  });
});

describe('isSourceStale（断档判定）', () => {
  const now = 1_700_000_000;

  it('关闭的渠道永远不算断档', () => {
    expect(isSourceStale(false, now - 86_400, now)).toBe(false);
  });

  it('从未触发过（0/undefined）不算断档，避免新启用渠道误报', () => {
    expect(isSourceStale(true, 0, now)).toBe(false);
    expect(isSourceStale(true, undefined, now)).toBe(false);
  });

  it('超过阈值（默认 30 分钟）判为断档，阈值内不判', () => {
    expect(isSourceStale(true, now - TRIGGER_GAP_THRESHOLD_SEC, now)).toBe(true); // 压线
    expect(isSourceStale(true, now - TRIGGER_GAP_THRESHOLD_SEC + 1, now)).toBe(false);
    expect(isSourceStale(true, now - 3600, now)).toBe(true); // 1 小时
  });
});
