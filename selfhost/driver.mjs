#!/usr/bin/env node
// CDT Monitor 自建触发驱动（self-hosted driver）
// 作用：在本机/服务器/软路由/NAS 上常驻，按固定间隔请求 Worker 的 /__cron?source=selfhost，
// 作为 GitHub Actions 之外的冗余触发源。零依赖（Node ≥ 18 内置 fetch）。
//
// 环境变量：
//   CDT_URL      触发地址，默认 https://cdt.dddde.de/__cron?source=selfhost
//   CDT_SECRET   CRON_SECRET（与 Worker 侧一致）
//   CDT_INTERVAL 触发间隔秒，默认 300（5 分钟）；建议 ≤ 前台「监控间隔」
//   CDT_ONCE     设为 1 时只跑一次（配合系统 crontab 使用）
//
// 用法：
//   node driver.mjs              # 常驻循环
//   CDT_ONCE=1 node driver.mjs   # 单次执行（crontab 每 5 分钟调一次）
//
// 退出码：0 正常；非 0 表示配置缺失（便于 systemd/cron 排错）

const url = process.env.CDT_URL || 'https://cdt.dddde.de/__cron?source=selfhost';
const secret = process.env.CDT_SECRET || '';
const intervalSec = Math.max(30, Number(process.env.CDT_INTERVAL || 300));
const once = process.env.CDT_ONCE === '1';

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

if (!secret) {
  console.error('缺少 CDT_SECRET（与 Worker 的 CRON_SECRET 一致），请在 /etc/cdt-trigger.env 中配置');
  process.exit(2);
}

async function tick() {
  const started = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'X-Cron-Secret': secret },
      signal: AbortSignal.timeout(60_000),
    });
    const text = await resp.text();
    const cost = Date.now() - started;
    if (resp.status === 200) {
      log(`OK ${resp.status} ${cost}ms ${text.slice(0, 200)}`);
    } else if (resp.status === 401) {
      log(`WARN ${resp.status} 密钥不匹配或未配置，请检查 CDT_SECRET 与 Worker 的 CRON_SECRET`);
    } else {
      log(`WARN ${resp.status} ${cost}ms ${text.slice(0, 200)}`);
    }
  } catch (err) {
    log(`ERROR ${String(err)}（网络抖动/超时，下轮自动重试）`);
  }
}

await tick();
if (!once) {
  log(`常驻模式：每 ${intervalSec} 秒触发一次 ${url}`);
  setInterval(tick, intervalSec * 1000);
}
