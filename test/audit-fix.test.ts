// 审计整改项的回归单测：时间格式化缓存 / 异常类型 / 密码哈希迭代数
import { describe, it, expect } from 'vitest';
import { formatWallClock } from '../src/engine/time';
import { AliyunError } from '../src/provider/aliyun';
import { hashPassword, verifyPassword } from '../src/security/security';
import { driverScript, installScript, uninstallScript } from '../src/engine/selfhost';

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

describe('自建驱动脚本（selfhost）', () => {
  const URL_ = 'https://cdt.example.com/__cron?source=selfhost';

  it('driver 首行是 shebang，install.sh 的自检校验能通过', () => {
    const driver = driverScript(URL_, 's3cr3t', 300);
    expect(driver.split('\n')[0]).toMatch(/^#!/);
    // install.sh 里有 head -n 1 driver.mjs | grep -q '^#!/'，模板一旦改坏这里会红
    expect(driver).toContain('#!/usr/bin/env node');
  });

  it('install.sh 内置内容异常自检，避免把错误提示文本当成脚本执行', () => {
    const install = installScript(URL_, 's3cr3t', 300);
    expect(install).toContain('head -n 1 "${DIR}/driver.mjs" | grep -q \'^#!/\'');
    expect(install).toContain('内容异常');
  });

  it('密钥与间隔被注入脚本，且单引号被转义', () => {
    const install = installScript(URL_, "it's-secret", 300);
    expect(install).toContain("SECRET='it\\'s-secret'");
    expect(install).toContain('INTERVAL=300');
    expect(driverScript(URL_, "it's-secret", 300)).toContain("secret: 'it\\'s-secret'");
  });

  it('配置真正落进 systemd 的 env 文件，而不是留在变量里', () => {
    const install = installScript(URL_, 's3cr3t', 300);
    expect(install).toContain("URL='https://cdt.example.com/__cron?source=selfhost'");
    expect(install).toContain("SECRET='s3cr3t'");
    expect(install).toContain('CDT_URL=${URL}');
    expect(install).toContain('CDT_SECRET=${SECRET}');
    expect(install).toContain('CDT_INTERVAL=${INTERVAL}');
    expect(install).not.toContain('<你的 CRON_SECRET>');
  });

  it('间隔过小会被收敛到 30 秒下限', () => {
    expect(installScript(URL_, 's3cr3t', 1)).toContain('INTERVAL=30');
  });

  it('卸载脚本清理两种安装方式且不含任何密钥', () => {
    const un = uninstallScript();
    expect(un.split('\n')[0]).toMatch(/^#!/);
    // systemd：停服务 + 禁自启 + 删 unit
    expect(un).toContain('systemctl stop "${UNIT}"');
    expect(un).toContain('rm -f "/etc/systemd/system/${UNIT}.service"');
    // crontab：只删本驱动的行（grep -v），不动其他任务
    expect(un).toContain('grep -v "${TARGET}/run.sh"');
    // 文件清理
    expect(un).toContain('rm -rf "${TARGET}"');
    expect(un).toContain('rm -f "${ENV_FILE}"');
    // 不含密钥/URL —— 内容固定，密钥丢了也能安全分发
    expect(un).not.toContain('SECRET');
    expect(un).not.toContain('s3cr3t');
  });
});
