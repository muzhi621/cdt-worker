// 通知层：Telegram / Webhook / 邮件(MailChannels)
// 对应原 Go 项目 internal/notify/service.go
// 注：Worker 无任意 TCP，SMTP 直连改由 MailChannels 免费 API 替代；SOCKS5 已放弃

export interface NotificationEvent {
  id: string;
  type: string;
  title: string;
  summary: string;
  accountId: number;
  fields: Record<string, string>;
  createdAt: string;
}

export interface NotifyConfig {
  email: { enabled: boolean; host: string; port: number; username: string; password: string; security: string; to: string };
  telegram: { enabled: boolean; token: string; chatId: string; proxyType: string; proxyUrl: string };
  webhook: { enabled: boolean; url: string; method: string; type: string; provider: string; headers: string; secret: string; body: string };
}

export function enabledChannels(config: NotifyConfig): string[] {
  const channels: string[] = [];
  if (config.email.enabled && config.email.to) channels.push('email');
  if (config.telegram.enabled && config.telegram.token && config.telegram.chatId) channels.push('telegram');
  if (config.webhook.enabled && config.webhook.url) channels.push('webhook');
  return channels;
}

function eventText(event: NotificationEvent): string {
  let text = `[CDT Monitor] ${event.title}\n${event.summary}`;
  for (const [k, v] of Object.entries(event.fields)) text += `\n${k}: ${v}`;
  return text;
}

async function sendTelegram(config: NotifyConfig['telegram'], event: NotificationEvent): Promise<void> {
  // 支持自定义 HTTPS 反代（proxyType === 'custom'），SOCKS5 已不支持
  let baseUrl = 'https://api.telegram.org';
  if (config.proxyType === 'custom' && config.proxyUrl) {
    baseUrl = config.proxyUrl.replace(/\/+$/, '');
  }
  const endpoint = `${baseUrl}/bot${config.token}/sendMessage`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ chat_id: config.chatId, text: eventText(event) }),
  });
  if (resp.status !== 200) {
    throw new Error(`telegram HTTP ${resp.status}: ${await resp.text()}`);
  }
}

async function sendWebhook(config: NotifyConfig['webhook'], event: NotificationEvent): Promise<void> {
  let endpoint = replaceTemplate(config.url, replacements(event), true);
  const method = config.method.toUpperCase() === 'POST' ? 'POST' : 'GET';
  let body: string | undefined;
  let contentType = 'application/json';

  if (method === 'GET') {
    const url = new URL(endpoint);
    url.searchParams.set('title', event.title);
    url.searchParams.set('message', event.summary);
    endpoint = url.toString();
  } else {
    if (config.body) {
      body = replaceTemplate(config.body, replacements(event), config.type === 'FORM');
      contentType = config.type === 'FORM' ? 'application/x-www-form-urlencoded' : 'application/json';
    } else if (config.type === 'FORM') {
      body = new URLSearchParams({ title: event.title, summary: event.summary, type: event.type }).toString();
      contentType = 'application/x-www-form-urlencoded';
    } else {
      body = JSON.stringify({ title: event.title, summary: event.summary, type: event.type, fields: event.fields, created_at: event.createdAt });
    }
  }

  const headers: Record<string, string> = { 'Content-Type': contentType };
  if (config.headers) {
    try {
      Object.assign(headers, JSON.parse(config.headers));
    } catch { /* 忽略无效 headers */ }
  }
  const resp = await fetch(endpoint, { method, headers, body });
  if (resp.status >= 400) {
    throw new Error(`webhook HTTP ${resp.status}: ${await resp.text()}`);
  }
}

// MailChannels 免费邮件 API（需在 Cloudflare DNS 配置 SPF/DKIM）
async function sendEmail(config: NotifyConfig['email'], event: NotificationEvent): Promise<void> {
  const payload = {
    personalizations: [{ to: [{ email: config.to }] }],
    from: { email: config.username, name: 'CDT Monitor' },
    subject: `CDT Monitor · ${event.title}`,
    content: [
      {
        type: 'text/html',
        value: renderEmail(event),
      },
    ],
  };
  const resp = await fetch('https://api.mailchannels.net/tx/v1/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (resp.status >= 400) {
    throw new Error(`email HTTP ${resp.status}: ${await resp.text()}`);
  }
}

function renderEmail(event: NotificationEvent): string {
  let rows = '';
  for (const [k, v] of Object.entries(event.fields)) {
    rows += `<tr><td style="padding:12px 0;color:#8e8e93;border-bottom:1px solid #eee">${escapeHtml(k)}</td><td style="padding:12px 0;text-align:right;font-weight:700;border-bottom:1px solid #eee">${escapeHtml(v)}</td></tr>`;
  }
  return `<!doctype html><html><body style="margin:0;background:#f2f2f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1c1c1e"><table width="100%"><tr><td align="center" style="padding:40px 20px"><table width="100%" style="max-width:560px;background:rgba(255,255,255,.92);border:1px solid #fff;border-radius:28px;box-shadow:0 24px 48px -12px rgba(0,0,0,.08)"><tr><td style="padding:36px"><div style="font-size:11px;font-weight:800;letter-spacing:.16em;color:#6e6e73">CDT MONITOR</div><h1 style="font-size:26px;margin:10px 0">${escapeHtml(event.title)}</h1><p style="color:#6e6e73">${escapeHtml(event.summary)}</p><table width="100%" style="margin-top:24px;border-top:1px solid #eee">${rows}</table></td></tr></table></td></tr></table></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function replacements(event: NotificationEvent): Record<string, string> {
  const traffic = (event.fields['当前流量'] ?? '').replace(/GB$/, '').trim();
  const threshold = (event.fields['设定阈值'] ?? '').replace(/%$/, '').trim();
  const createdAt = new Date(event.createdAt).toISOString();
  return {
    '#TITLE#': event.title,
    '#MSG#': event.summary,
    '#ACCOUNT#': String(event.accountId),
    '#ACCOUNT_ID#': String(event.accountId),
    '#TRAFFIC#': traffic,
    '#TRAFFIC_GB#': traffic,
    '#MAX_TRAFFIC#': threshold,
    '#THRESHOLD_PERCENT#': threshold,
    '#INSTANCE#': event.fields['实例'] ?? '',
    '#STATUS#': event.fields['实例状态'] ?? '',
    '#TYPE#': event.type,
    '#CREATED_AT#': createdAt,
    '#TIME#': createdAt,
  };
}

function replaceTemplate(input: string, reps: Record<string, string>, urlEncode: boolean): string {
  let out = input;
  for (const [k, v] of Object.entries(reps)) {
    out = out.split(k).join(urlEncode ? encodeURIComponent(v) : JSON.stringify(v).replace(/^"|"$/g, ''));
  }
  return out;
}

export async function send(channel: string, event: NotificationEvent, config: NotifyConfig): Promise<void> {
  switch (channel) {
    case 'email':
      return sendEmail(config.email, event);
    case 'telegram':
      return sendTelegram(config.telegram, event);
    case 'webhook':
      return sendWebhook(config.webhook, event);
    default:
      throw new Error(`unsupported notification channel ${channel}`);
  }
}
