// 触发源（渠道开关 / 来源识别 / 断档判定）单测
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TRIGGER_SOURCES, isSourceStale, normalizeSource,
  parseTriggerSeen, parseTriggerSources, TRIGGER_GAP_THRESHOLD_SEC,
} from '../src/engine/triggers';

describe('normalizeSource（来源识别）', () => {
  it('显式声明的渠道', () => {
    expect(normalizeSource('github')).toBe('github');
    expect(normalizeSource('GitHub_Actions')).toBe('github');
    expect(normalizeSource('selfhost')).toBe('selfhost');
    expect(normalizeSource('driver')).toBe('selfhost');
    expect(normalizeSource('native')).toBe('native');
    expect(normalizeSource('scheduled')).toBe('native');
    expect(normalizeSource('http')).toBe('http');
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
    const parsed = parseTriggerSources('{"github":false,"selfhost":true,"native":"yes"}');
    expect(parsed.github).toBe(false);
    expect(parsed.selfhost).toBe(true);
    expect(parsed.native).toBe(DEFAULT_TRIGGER_SOURCES.native); // 非布尔 → 保持默认
    expect(parsed.http).toBe(DEFAULT_TRIGGER_SOURCES.http);
  });

  it('时间戳解析：只保留正数，非法数据返回空', () => {
    expect(parseTriggerSeen('{"github":1700000000,"http":0}')).toEqual({ github: 1700000000 });
    expect(parseTriggerSeen(null)).toEqual({});
    expect(parseTriggerSeen('not-json')).toEqual({});
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
