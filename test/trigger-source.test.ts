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
    expect(normalizeSource('http')).toBe('http');
  });

  // 原生 Cron 已移除：历史别名 'cron' / 'scheduled' 归入 http，而不是报错或NaN
  it('原生 Cron 已移除，历史别名降级为 http', () => {
    expect(normalizeSource('cron')).toBe('http');
    expect(normalizeSource('scheduled')).toBe('http');
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

  // 原生 Cron 移除后，D1 里存量的 {"native":false} 必须被静默忽略，
  // 否则老部署的数据读出来会带着一个不存在的渠道，界面多出一行幽灵开关。
  it('存量数据里的 native 键被忽略，不会污染配置', () => {
    const parsed = parseTriggerSources('{"native":true,"http":false}');
    expect('native' in parsed).toBe(false);
    expect(parsed.http).toBe(false);
    const seen = parseTriggerSeen('{"native":1700000000,"github":1700000001}');
    expect('native' in seen).toBe(false);
    expect(seen.github).toBe(1700000001);
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
