# 自建监控驱动 & 大厂免费触发方案

目标：**不要只依赖一个触发渠道**。GitHub Actions 的 schedule 会在高峰期延迟、丢跑，且长时间无提交时会被自动禁用；一旦断档，实例会错过整天的开关机窗口持续产生费用。

Worker 侧已提供「触发源开关 + 上次触发时间 + 断档告警」，本文件说明如何把冗余渠道搭起来。

---

## 一、渠道与来源标识

触发 `/__cron` 时用 `?source=` 或 `X-Trigger-Source` 头声明身份（未声明归为 `http`）：

| source | 渠道 | 说明 |
| --- | --- | --- |
| `github` | GitHub Actions | 仓库内置 `cron.yml` |
| `http` | 外部定时服务 | cron-job.org、自架 curl cron 等 |
| `selfhost` | 自建驱动 / 云函数 | 自建脚本、腾讯云 SCF、阿里云 FC 等 |
| `native` | Cloudflare 原生 Cron | 需账号有 cron 额度（免费版仅 5 个） |

在管理台 **设置 → 监控触发源** 可对每个渠道独立开关、查看上次触发时间、并点「测试」验证链路。

---

## 二、自建驱动（推荐：常驻、可控）

### 方式 A：管理台复制下载链接（最省事）

1. 设置 → 监控触发源 → 展开教程 → ③ 自建驱动
2. 填写「触发地址 / CRON_SECRET / 间隔」
3. 点「复制一键命令」，粘贴到服务器执行：

```bash
curl -o cdt-driver.mjs "<driver 链接>" && curl -o install.sh "<install 链接>" && sudo bash install.sh
```

链接内含你的密钥，请勿外传。

### 方式 B：从仓库获取（通用版，配置走环境变量）

```bash
git clone https://github.com/muzhi621/cdt-worker
cd cdt-worker/selfhost
sudo bash install.sh            # 交互式：填地址、密钥、间隔
# 或非交互：
CDT_URL="https://你的域名/__cron?source=selfhost" CDT_SECRET="你的密钥" sudo bash install.sh
bash install.sh --docker        # 改用容器运行
bash install.sh --uninstall     # 卸载
```

脚本行为：写 `/etc/cdt-trigger.env` → 安装 systemd 服务（Node ≥ 18）；没有 Node 或没有 systemd 时自动降级为 crontab + curl。查看日志：`journalctl -u cdt-trigger -f`。

---

## 三、腾讯云云函数 SCF（长期免费额度）

SCF 每月有 100 万次免费调用 + 40 万 GBs 免费资源使用量，每 5 分钟触发一次（每月约 9000 次）远在额度内。

1. 云函数 SCF → 新建 → **运行环境 Node.js 18/20** → 粘贴代码：

```js
// 入口：main_handler
const https = require('https');

exports.main_handler = async () => {
  const url = process.env.CDT_URL || 'https://你的域名/__cron?source=selfhost';
  const secret = process.env.CDT_SECRET || '';
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'X-Cron-Secret': secret }, timeout: 60000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: body.slice(0, 200) }));
    });
    req.on('error', (e) => resolve({ error: String(e) }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
};
```

2. 函数配置 → 环境变量：`CDT_URL`（带 `?source=selfhost`）、`CDT_SECRET`
3. 触发方式 → **定时触发器（Timer）**，Cron 表达式 `0 */5 * * * *`（腾讯云为 6 位，含秒）
4. 保存启用；如需确认出网，在函数日志里看返回 `{"monitored":N,...}`

---

## 四、阿里云函数计算 FC 3.0（长期免费额度）

FC 3.0 每月有 100 万次免费调用额度。

1. 函数计算 FC → 创建函数 → **运行环境 Node.js 18/20** → 粘贴代码：

```js
// 入口：handler
exports.handler = async (event, context) => {
  const url = process.env.CDT_URL || 'https://你的域名/__cron?source=selfhost';
  const secret = process.env.CDT_SECRET || '';
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { 'X-Cron-Secret': secret },
      signal: AbortSignal.timeout(60000),
    });
    const text = await resp.text();
    return { statusCode: resp.status, body: text.slice(0, 200) };
  } catch (err) {
    return { statusCode: 500, body: String(err) };
  }
};
```

2. 配置 → 环境变量：`CDT_URL`、`CDT_SECRET`
3. 触发器 → **时间触发器**，Cron 表达式 `0 */5 * * *`（5 位）；确认开启「允许访问公网」
4. 地域建议选香港或国内地域（需能出网访问你的 Worker 域名）

> 华为云 FunctionGraph、百度智能云 CFC 同理，均为「定时触发器 + HTTP 请求」。

---

## 五、cron-job.org（免费，第二渠道首选）

1. 新建 Cronjob，URL：`https://你的域名/__cron?source=http`
2. Advanced → Headers：`X-Cron-Secret: <你的 CRON_SECRET>`
3. 周期 Every 5 minutes，保存

---

## 六、验证与排错

- **验证通路**：管理台 → 设置 → 监控触发源 → 对应渠道点「测试」（会以该渠道身份真实跑一轮监控，绕过防抖）
- **验证外部服务**：看该渠道的「上次触发时间」是否随周期更新；超过 30 分钟没更新，日志页会写入 warning：`触发源「XXX」已断档 N 分钟没有触发`
- **401**：`CRON_SECRET` 两边不一致，或请求没带 `X-Cron-Secret` 头
- **被忽略**：该渠道在管理台被关闭（Worker 返回 `{"skipped":true,"reason":"source_disabled"}`）
- **重复执行不会**：所有渠道共用防抖 + 原子槽位抢占，多源同时触发同一窗口内只跑一轮
