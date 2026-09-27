// 审计整改项的回归单测：时间格式化缓存 / 异常类型 / 密码哈希迭代数
import { describe, it, expect } from 'vitest';
import { formatWallClock } from '../src/engine/time';
import { AliyunError } from '../src/provider/aliyun';
import { hashPassword, verifyPassword } from '../src/security/security';

describe('formatWallClock（日志展示用，复用 formatter 缓存）', () => {
  it('输出 YYYY-MM-DD HH:mm:ss 墙钟格式', () => {
    const d = new Date(Date.UTC(2026, 8, 27, 1, 2, 3));
    expect(formatWallClock(d, 'Asia/Shanghai')).toBe('2026-09-27 09:02:03');
    expect(formatWallClock(d, 'UTC')).toBe('2026-09-27 01:02:03');
    expect(formatWallClock(d, 'America/New_York')).toBe('2026-09-26 21:02:03');
  });

  it('非法时区回退为 ISO 而非抛错', () => {
    const d = new Date(Date.UTC(2026, 8, 27, 1, 2, 3));
    expect(formatWallClock(d, 'Not/AZone')).toBe('2026-09-27 01:02:03');
  });
});

describe('AliyunError（替代 as any 挂属性）', () => {
  it('默认不可重试', () => {
    const err = new AliyunError('boom');
    expect(err.retryable).toBe(false);
    expect(err.name).toBe('AliyunError');
    expect(err).toBeInstanceOf(Error);
  });

  it('可标记为可重试（5xx / 429 / 网络错误）', () => {
    expect(new AliyunError('timeout', true).retryable).toBe(true);
  });
});

describe('hashPassword / verifyPassword', () => {
  it('使用降版后的迭代数，且格式带 i= 段', async () => {
    const hash = await hashPassword('correct-horse-battery');
    const m = /\$i=(\d+)\$/.exec(hash);
    expect(m).not.toBeNull();
    // 60k 迭代会撞 Free 计划 10ms/请求上限，这里锁定为 12000
    expect(Number(m![1])).toBe(12000);
  });

  it('正确密码通过、错误密码拒绝', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(await verifyPassword(hash, 'correct-horse-battery')).toBe(true);
    expect(await verifyPassword(hash, 'wrong-password!!')).toBe(false);
  });

  it('损坏的 base64 段降级为验证失败而不是抛错', async () => {
    expect(await verifyPassword('$pbkdf2-sha256$i=12000$$!!!not-base64!!!', 'x'.repeat(20))).toBe(false);
  });
});
