#!/usr/bin/env bash
# CDT Monitor 自建触发驱动 · 一键安装脚本
# 用途：装一个常驻进程，每 N 分钟请求 Worker 的 /__cron?source=selfhost，
#       作为 GitHub Actions 之外的冗余触发源（避免单一渠道断档导致实例白跑）。
#
# 用法：
#   sudo bash install.sh                          # 交互式安装（systemd，无 systemd 自动降级 crontab）
#   CDT_URL=... CDT_SECRET=... sudo bash install.sh   # 非交互（自动化部署）
#   bash install.sh --docker                      # 生成 docker-compose.yml 并用容器运行
#   bash install.sh --uninstall                   # 卸载
#
# 依赖：Node ≥ 18（有则用它；没有且 --docker 未指定时，自动降级为 curl + crontab）

set -euo pipefail

UNIT_NAME="cdt-trigger"
ENV_FILE="/etc/${UNIT_NAME}.env"
INSTALL_DIR="/opt/${UNIT_NAME}"
SERVICE_FILE="/etc/systemd/system/${UNIT_NAME}.service"
DEFAULT_URL="https://cdt.dddde.de/__cron?source=selfhost"

say() { printf '\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
die() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

need_root() { [ "$(id -u)" = "0" ] || die "请用 root 执行：sudo bash install.sh"; }

uninstall() {
  need_root
  systemctl stop "${UNIT_NAME}" 2>/dev/null || true
  systemctl disable "${UNIT_NAME}" 2>/dev/null || true
  rm -f "${SERVICE_FILE}" "${ENV_FILE}"
  rm -rf "${INSTALL_DIR}"
  crontab -l 2>/dev/null | grep -v "${UNIT_NAME}" | crontab - 2>/dev/null || true
  systemctl daemon-reload 2>/dev/null || true
  say "已卸载 ${UNIT_NAME}"
  exit 0
}

docker_mode() {
  command -v docker >/dev/null 2>&1 || die "未检测到 docker，请先安装 Docker"
  read -r -p "触发地址 [${DEFAULT_URL}]: " url || true
  url="${url:-$DEFAULT_URL}"
  read -r -p "CRON_SECRET: " secret
  [ -n "${secret}" ] || die "CRON_SECRET 不能为空"
  read -r -p "触发间隔秒 [300]: " interval || true
  interval="${interval:-300}"
  mkdir -p "${UNIT_NAME}-docker"
  cat > "${UNIT_NAME}-docker/docker-compose.yml" <<YML
services:
  cdt-trigger:
    image: node:20-alpine
    restart: unless-stopped
    environment:
      CDT_URL: "${url}"
      CDT_SECRET: "${secret}"
      CDT_INTERVAL: "${interval}"
    volumes:
      - ./driver.mjs:/app/driver.mjs:ro
    command: ["node", "/app/driver.mjs"]
YML
  cp "$(dirname "$0")/driver.mjs" "${UNIT_NAME}-docker/driver.mjs"
  (cd "${UNIT_NAME}-docker" && docker compose up -d)
  say "Docker 模式已启动：cd ${UNIT_NAME}-docker && docker compose logs -f"
  exit 0
}

[ "${1:-}" = "--uninstall" ] && uninstall
[ "${1:-}" = "--docker" ] && docker_mode

need_root
mkdir -p "${INSTALL_DIR}"
cp "$(dirname "$0")/driver.mjs" "${INSTALL_DIR}/driver.mjs"

# 参数：优先环境变量（支持无人值守部署），否则交互询问
url="${CDT_URL:-}"
secret="${CDT_SECRET:-}"
interval="${CDT_INTERVAL:-300}"
if [ -z "${url}" ]; then read -r -p "触发地址 [${DEFAULT_URL}]: " url || true; fi
url="${url:-$DEFAULT_URL}"
if [ -z "${secret}" ]; then read -r -p "CRON_SECRET（与 Worker 侧一致）: " secret || true; fi
[ -n "${secret}" ] || die "CRON_SECRET 不能为空"

cat > "${ENV_FILE}" <<ENV
CDT_URL=${url}
CDT_SECRET=${secret}
CDT_INTERVAL=${interval}
ENV
chmod 600 "${ENV_FILE}"
say "配置已写入 ${ENV_FILE}"

if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
  NODE_MAJOR="$("${NODE_BIN}" -p 'process.versions.node.split(".")[0]')"
  if [ "${NODE_MAJOR}" -lt 18 ]; then warn "Node 版本 < 18，降级为 curl + crontab 模式"; NODE_BIN=""; fi
else
  warn "未检测到 Node，降级为 curl + crontab 模式"
  NODE_BIN=""
fi

if command -v systemctl >/dev/null 2>&1 && systemctl is-system-running >/dev/null 2>&1 && [ -n "${NODE_BIN}" ]; then
  cat > "${SERVICE_FILE}" <<UNIT
[Unit]
Description=CDT Monitor self-hosted trigger
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/driver.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now "${UNIT_NAME}"
  say "已安装并启动 systemd 服务 ${UNIT_NAME}"
  say "查看日志：journalctl -u ${UNIT_NAME} -f"
  say "查看状态：systemctl status ${UNIT_NAME}"
else
  # 降级方案：crontab 每分钟检查，进程不存在则拉起（简单可靠，无需守护进程）
  cat > "${INSTALL_DIR}/run.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
# shellcheck disable=SC1091
[ -f /etc/cdt-trigger.env ] && . /etc/cdt-trigger.env
if [ -n "${CDT_URL:-}" ] && command -v curl >/dev/null 2>&1; then
  curl -sS -m 60 -H "X-Cron-Secret: ${CDT_SECRET}" "${CDT_URL}" \
    | sed "s/^/[$(date -Is)] /" >> /var/log/cdt-trigger.log 2>&1 || true
fi
SH
  chmod +x "${INSTALL_DIR}/run.sh"
  ( crontab -l 2>/dev/null | grep -v "${UNIT_NAME}"; echo "*/${INTERVAL_CRON:-5} * * * * ${INSTALL_DIR}/run.sh" ) | crontab -
  say "已安装 crontab 定时任务（每 ${INTERVAL_CRON:-5} 分钟）：crontab -l"
  say "查看日志：tail -f /var/log/cdt-trigger.log"
fi

say "验证：等待一个周期后到管理台 → 设置 → 监控触发源，确认「自建驱动」的上次触发时间已更新"
