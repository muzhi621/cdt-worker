// 密码哈希与常量时间比较单测
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, constantTimeEqual } from '../src/security/security';

describe('hashPassword / verifyPassword（PBKDF2-SHA256）', () => {
  it('正确密码验证通过，错误密码拒绝', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(await verifyPassword(hash, 'correct-horse-battery')).toBe(true);
    expect(await verifyPassword(hash, 'wrong-password-123')).toBe(false);
  });

  it('同一密码两次哈希盐不同（防彩虹表）', async () => {
    const h1 = await hashPassword('same-password-123');
    const h2 = await hashPassword('same-password-123');
    expect(h1).not.toBe(h2);
    expect(await verifyPassword(h1, 'same-password-123')).toBe(true);
    expect(await verifyPassword(h2, 'same-password-123')).toBe(true);
  });

  it('哈希格式带迭代次数，格式损坏时返回 false 而非抛错', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
    expect(await verifyPassword('$argon2id$i=3$salt$hash', 'x')).toBe(false);
    expect(await verifyPassword('$pbkdf2-sha256$i=bad$salt$hash', 'x')).toBe(false);
    expect(await verifyPassword('$pbkdf2-sha256$i=60000$!!!bad-base64!!!$hash', 'x')).toBe(false);
  });

  it('低于最小长度时抛错（调用方应先校验）', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 10/);
  });
});

describe('constantTimeEqual（常量时间比较）', () => {
  it('相同返回 true，不同返回 false', async () => {
    expect(await constantTimeEqual('abc', 'abc')).toBe(true);
    expect(await constantTimeEqual('abc', 'abd')).toBe(false);
  });

  it('长度不同返回 false（经 SHA-256 归一化，不泄露长度差异）', async () => {
    expect(await constantTimeEqual('a', 'abcdefgh')).toBe(false);
    expect(await constantTimeEqual('', '')).toBe(true);
  });

  it('适合做密钥比较：前缀相同但结尾不同也能区分', async () => {
    const secret = 'cron-secret-0123456789abcdef';
    expect(await constantTimeEqual(secret, secret)).toBe(true);
    expect(await constantTimeEqual(secret, secret.slice(0, -1) + 'X')).toBe(false);
  });
});
