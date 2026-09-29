// 通知凭据加密存储（P1-2）回归单测：敏感字段 AES-GCM 加密/解密 + 旧库明文平滑迁移
import { describe, it, expect } from 'vitest';
import { encryptNotifyConfig, decryptNotifyConfig } from '../src/store/store';
import { isEncrypted } from '../src/security/security';

const MASTER = Buffer.from(new Uint8Array(32).map((_, i) => i + 1)).toString('base64');
const env = { CDT_MASTER_KEY: MASTER } as never;

function sample() {
  return {
    telegram: { enabled: true, token: '111:telegram-token', chatId: '42', proxyType: 'none', proxyUrl: '' },
    webhook: {
      enabled: true, url: 'https://hook.example.com/?access_token=tok-123', method: 'POST', type: 'JSON',
      provider: 'generic', headers: '{"Authorization":"Bearer tok-123"}', secret: 'wh-secret', body: '',
    },
    serverchan: { enabled: false, sendKey: 'SCT-key' },
    pushplus: { enabled: false, token: 'pp-token' },
    smtp: { enabled: true, host: 'smtp.example.com', port: 465, username: 'u', password: 'mail-pass', from: '', to: 'a@b.c' },
    template: { body: '{{账号}} {{使用率}}' },
  };
}

describe('通知凭据加密存储', () => {
  it('落库前敏感字段全部加密，非敏感字段保持明文', async () => {
    const cfg = sample();
    const enc = await encryptNotifyConfig(env, cfg);
    expect(isEncrypted(enc.telegram.token as string)).toBe(true);
    expect(isEncrypted(enc.webhook.secret as string)).toBe(true);
    expect(isEncrypted(enc.serverchan.sendKey as string)).toBe(true);
    expect(isEncrypted(enc.pushplus.token as string)).toBe(true);
    expect(isEncrypted(enc.smtp.password as string)).toBe(true);
    // P1-6：webhook 的 url / headers 也已归入密钥语义——钉钉/飞书/企业微信机器人的
    // access_token 就写在 URL 查询串里，headers 常被填成 {"Authorization":"Bearer xxx"}，
    // 明文落库等于交出机器人发信权限，故同样加密。
    expect(isEncrypted(enc.webhook.url as string)).toBe(true);
    expect(isEncrypted(enc.webhook.headers as string)).toBe(true);
    // 非敏感字段（host / username / 模板）保持明文
    expect(enc.smtp.host).toBe('smtp.example.com');
    expect(enc.template.body).toBe('{{账号}} {{使用率}}');
  });

  it('解密还原明文，与投递所需一致', async () => {
    const enc = await encryptNotifyConfig(env, sample());
    const dec = await decryptNotifyConfig(env, enc);
    expect(dec.telegram.token).toBe('111:telegram-token');
    expect(dec.smtp.password).toBe('mail-pass');
    expect(dec.webhook.secret).toBe('wh-secret');
  });

  it('旧库明文值解密时原样透传（平滑迁移，不崩）', async () => {
    const plain = sample();
    const dec = await decryptNotifyConfig(env, plain);
    expect(dec.telegram.token).toBe('111:telegram-token');
    expect(dec.smtp.password).toBe('mail-pass');
  });

  it('encryptNotifyConfig 幂等：已加密值跳过，不二次加密', async () => {
    const once = await encryptNotifyConfig(env, sample());
    const twice = await encryptNotifyConfig(env, once);
    expect(twice.telegram.token).toBe(once.telegram.token);
    expect(twice.smtp.password).toBe(once.smtp.password);
  });

  it('空串敏感字段不加密（保持空，供 merge 继承逻辑判断）', async () => {
    const cfg = sample();
    (cfg.telegram as Record<string, unknown>).token = '';
    const enc = await encryptNotifyConfig(env, cfg);
    expect(enc.telegram.token).toBe('');
  });
});
