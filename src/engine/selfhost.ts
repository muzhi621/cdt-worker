// 自建驱动（self-hosted driver）脚本模板
// 管理台「下载」按钮会按用户填写的地址/密钥/间隔生成可直接运行的脚本：
// driver.mjs 已内置配置（仍可用环境变量覆盖），install.sh 负责写 env + systemd/crontab。
//
// 说明：仓库 selfhost/ 目录下的同名脚本是「通用版」（配置走环境变量，供 git clone 用户使用）；
// 这里生成的是「已填好配置的便携版」，两者逻辑一致，目的都是作为 GitHub Actions 之外的冗余触发源。

function q(v: string): string {
  // 单引号字符串转义（防注入/语法破坏）
  return String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function driverScript(url: string, secret: string, interval: number): string {
  return `#!/usr/bin/env node
// CDT Monitor 自建触发驱动（已内置配置，可直接 node driver.mjs 运行）
// 环境变量仍可覆盖：CDT_URL / CDT_SECRET / CDT_INTERVAL / CDT_ONCE=1（单次）
const DEFAULTS = {
  url: '${q(url)}',
  secret: '${q(secret)}',
  interval: ${Math.max(30, Math.floor(interval))},
};

const url = process.env.CDT_URL || DEFAULTS.url;
const secret = process.env.CDT_SECRET || DEFAULTS.secret;
const intervalSec = Math.max(30, Number(process.env.CDT_INTERVAL || DEFAULTS.interval));
const once = process.env.CDT_ONCE === '1';
const log = (m) => console.log(\`[\${new Date().toISOString()}] \${m}\`);

if (!secret) {
  console.error('缺少 CDT_SECRET');
  process.exit(2);
}

async function tick() {
  const started = Date.now();
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'X-Cron-Secret': secret },
      signal: AbortSignal.timeout(60000),
    });
    const text = await resp.text();
    log(\`\${resp.status} \${Date.now() - started}ms \${text.slice(0, 200)}\`);
  } catch (err) {
    log(\`ERROR \${String(err)}（下轮自动重试）\`);
  }
}

await tick();
if (!once) {
  log(\`常驻模式：每 \${intervalSec} 秒触发一次 \${url}\`);
  setInterval(tick, intervalSec * 1000);
}
`;
}

export function installScript(url: string, secret: string, interval: number): string {
  return `#!/usr/bin/env bash
# CDT Monitor 自建触发驱动 · 一键安装（已内置配置）
# 用法：把 driver.mjs 与本脚本放在同一目录，然后 sudo bash install.sh
set -euo pipefail

UNIT="cdt-trigger"
DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="/opt/\${UNIT}"
ENV_FILE="/etc/\${UNIT}.env"
URL='${q(url)}'
SECRET='${q(secret)}'
INTERVAL=${Math.max(30, Math.floor(interval))}

[ "$(id -u)" = "0" ] || { echo "请用 root 执行：sudo bash install.sh"; exit 1; }
[ -f "\${DIR}/driver.mjs" ] || { echo "未找到 driver.mjs，请与本脚本放在同一目录"; exit 1; }

mkdir -p "\${TARGET}"
cp "\${DIR}/driver.mjs" "\${TARGET}/driver.mjs"
cat > "\${ENV_FILE}" <<ENV
CDT_URL=\${URL}
CDT_SECRET=\${SECRET}
CDT_INTERVAL=\${INTERVAL}
ENV
chmod 600 "\${ENV_FILE}"
echo "配置已写入 \${ENV_FILE}"

NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  MAJ="$(node -p 'process.versions.node.split(".")[0]')"
  [ "\${MAJ}" -ge 18 ] && NODE_BIN="$(command -v node)"
fi

if [ -n "\${NODE_BIN}" ] && command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1; then
  cat > "/etc/systemd/system/\${UNIT}.service" <<UNIT_FILE
[Unit]
Description=CDT Monitor self-hosted trigger
After=network-online.target
[Service]
Type=simple
EnvironmentFile=\${ENV_FILE}
ExecStart=\${NODE_BIN} \${TARGET}/driver.mjs
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
UNIT_FILE
  systemctl daemon-reload
  systemctl enable --now "\${UNIT}"
  echo "已安装并启动 systemd 服务；查看日志：journalctl -u \${UNIT} -f"
else
  cat > "\${TARGET}/run.sh" <<'RUN'
#!/usr/bin/env bash
[ -f /etc/cdt-trigger.env ] && . /etc/cdt-trigger.env
if [ -n "\${CDT_URL:-}" ] && command -v curl >/dev/null 2>&1; then
  curl -sS -m 60 -H "X-Cron-Secret: \${CDT_SECRET}" "\${CDT_URL}" | sed "s/^/[$(date -Is)] /" >> /var/log/cdt-trigger.log 2>&1 || true
fi
RUN
  chmod +x "\${TARGET}/run.sh"
  ( crontab -l 2>/dev/null | grep -v "\${UNIT}"; echo "*/5 * * * * \${TARGET}/run.sh" ) | crontab -
  echo "未检测到 Node 18+/systemd，已降级为 crontab（每 5 分钟）；日志：tail -f /var/log/cdt-trigger.log"
fi

echo "完成后到管理台 → 设置 → 监控触发源，确认「自建驱动」的上次触发时间已更新"
`;
}
