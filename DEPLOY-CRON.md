# 监控定时触发配置（外部触发为主，原生 Cron 可选）

## 触发源渠道与冗余（推荐至少开两个）

每个渠道可**独立开关**（管理台 → 设置 → 监控触发源），并可查看「上次触发时间」；
已启用的渠道超过 30 分钟没触发，日志页会写入 warning（断档告警）。

| source 参数 | 渠道 | 教程 |
| --- | --- | --- |
| `github` | GitHub Actions | 本文件下方 |
| `http` | cron-job.org 等外部定时服务 | 本文件下方 |
| `selfhost` | 自建驱动 | [docs/SELFHOST.md](./docs/SELFHOST.md) |
| `native` | Cloudflare 原生 Cron | 本文件下方（需账号 cron 额度） |
| `tencent` | 腾讯云云函数 SCF | 管理台 → 定时监控配置 → 各渠道配置教程 ④ |
| `aliyun` | 阿里云函数计算 FC | 管理台 → 定时监控配置 → 各渠道配置教程 ⑤ |
| `huawei` | 华为云函数 FG（免费额度充足） | 本文件下方 / 管理台教程 ⑥ |

> 渠道标识还支持别名：`huawei` / `fg` / `huaweicloud` / `functiongraph` 都识别为华为云；
> `scf` / `tencentcloud` 识别为腾讯云，`fc` / `alicloud` 识别为阿里云。

触发时带上来源标识（查询参数或请求头二选一），例如：

```
https://你的域名/__cron?source=github
curl -H "X-Trigger-Source: selfhost" -H "X-Cron-Secret: <密钥>" https://你的域名/__cron
```

> CDT-Monitor Worker 版现在使用**双链路**定时触发，默认启用的是外部触发：
> 1. **主链路（默认）**：外部定时服务（cron-job.org / GitHub Actions 等）请求 `/__cron`，需携带 `CRON_SECRET`；
> 2. **可选增强**：Cloudflare 原生 Cron Trigger（`wrangler.toml` 的 `[triggers]`），`scheduled()` 直调内部监控函数，**无需密钥**。
>
> 两条链路共用 Worker 内部防抖（前台「监控间隔」分钟数）+ 原子槽位抢占，
> 无论多少个触发源同时打过来，同一防抖窗口内只有一轮监控真正执行。
>
> ⚠️ **额度提醒**：Cloudflare 免费版每个账号只有 **5 个 Cron Trigger** 额度，本项目占用 1 个。
> 若账号额度已用尽，`wrangler deploy` 会在注册 cron 时直接失败并报
> `error 10072`，导致整个部署中断（代码已上传但触发器配置回滚失败）。
> 删掉 `wrangler.toml` 的 `[triggers]` 段或腾出其他 Worker 的额度即可恢复。

---

## `/__cron` 鉴权规则（重要变更）

`/__cron` 不再是公开接口。放行条件（满足其一）：

| 通道 | 适用场景 | 怎么配 |
| --- | --- | --- |
| `CRON_SECRET` | 外部定时服务 / curl | Worker 环境变量设 `CRON_SECRET`，请求带 `X-Cron-Secret: <值>` 头或 `?key=<值>` 参数 |
| 管理员会话 | 管理台「立即监控」按钮 | 已登录状态下前台按钮自动可用，无需额外配置 |

- **未配置 `CRON_SECRET` 时**：外部匿名请求会得到 `401`，只有管理员会话能触发。
- **浏览器直接访问 `/__cron`**：未登录会得到 401 —— 这是预期行为（旧文档说"无需登录"已过时）。
- 原生 Cron Trigger 走 `scheduled()` 入口，不经过 HTTP 层，完全不受上述限制。

---

## 外部触发链路：`/__cron`

外部服务定时请求 `/__cron` 即可（原生 Cron 链路见下方「Cloudflare 原生 Cron Trigger：现已启用」）：

```
https://你的worker地址/__cron   （带 X-Cron-Secret 头）
```

实际监控频率由前台「监控间隔」控制（防抖跳过多余触发）。

### 启用步骤（二选一，推荐 GitHub Actions）

**A. GitHub Actions**（仓库已内置 `.github/workflows/cron.yml`，每 5 分钟一次）

1. Worker 侧设置环境变量 `CRON_SECRET`（Dashboard → Worker → Settings → Variables and Secrets，类型选 **Secret**），值用 `openssl rand -hex 32` 生成；
2. GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret，名称 `CRON_SECRET`，值与上一步一致；
3. 在 Actions 页面手动 Run workflow 验证一次。

**B. cron-job.org / 其他外部服务**

1. URL 填 `https://你的worker地址/__cron`；
2. 添加请求头 `X-Cron-Secret: <你的 CRON_SECRET>`（不支持 header 的服务可用 `?key=<你的 CRON_SECRET>`）；
3. 调度频率建议 ≥ 前台「监控间隔」。

---

## Cloudflare 原生 Cron Trigger：现已启用

`wrangler.toml` 含 `[triggers] crons = ["*/5 * * * *"]`，`src/index.ts` 导出了 `scheduled()`。
CF 每 5 分钟调用一次，**不经过 HTTP 层、无需 `CRON_SECRET`**。

| 项目 | 说明 |
| --- | --- |
| 频率 | 固定每 5 分钟，**cron 表达式不能运行时修改**，改一次要改 `wrangler.toml` 并重新部署 |
| 实际执行频率 | 由管理台「监控触发源」的渠道开关 + 「设置」页的**监控间隔**共同决定，改间隔即时生效 |
| 额度 | 免费版 Cron Trigger 是**账号级 5 个**（Paid 250 个），本项目占用 1 个 |
| 部署失败 | 账号额度用尽时 `wrangler deploy` 会报 `error 10072`（`has reached the Workers Free limit of 5 cron triggers per account`），整个部署会失败 |
| CPU | Free 计划 10ms/请求，`scheduled` 事件同样计费；只在被调用时计费，不空转 |

因此：

- 若 `wrangler deploy` 报 `error 10072`：删掉 `wrangler.toml` 的 `[triggers]` 段再部署（监控会退回纯外部触发），
  或删除账号上其他 Worker 的 cron 触发器腾额度。
- Dashboard → Worker → Triggers 页里若看到**手工创建**的残留 cron 条目
  （wrangler 无法删除手工创建的条目），请在该页面手动删除，否则残留条目的调用会因缺少
  `scheduled` 处理函数而进入失败状态。
- 渠道开关见管理台「监控触发源」的六个渠道：
  GitHub Actions / 外部定时服务 / 自建驱动 / **Cloudflare 原生 Cron** / 腾讯云 SCF / 阿里云 FC。

### 监控间隔如何影响原生 Cron

CF 固定每 5 分钟叫一次，但「设置」页的**监控间隔**决定真实执行频率：

- 间隔 = 5 分钟 → 每 5 分钟真跑一次
- 间隔 = 15 分钟 → CF 叫 3 次，第 1 次真跑，后 2 次直接跳过（不调阿里云 API）
- 间隔 = 0 → 视为不限制，由 CF 的 5 分钟频率兜底

**跳过的轮次不会写「上次触发时间」。** 这是刻意的：否则触发时间被自己不断刷新，
30 分钟断档阈值永远不会命中，告警形同虚设，而实际上监控在空转。

> ⚠️ 如果你把某个渠道的开关关掉，它的「上次触发」会停止更新，
> 超过 30 分钟就会在日志里出现断档告警——这是预期行为，提醒你该渠道没在工作。

---

仓库已内置 `.github/workflows/cron.yml`（每 5 分钟请求一次 `/__cron`）。启用步骤：

1. 在 Worker 侧设置环境变量 `CRON_SECRET`（Dashboard → Worker → Settings → Variables and Secrets，类型选 Secret），值自定义，例如 `openssl rand -hex 32` 生成。
2. 在 GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret，名称 `CRON_SECRET`，值与上一步一致。
3. 推送仓库后 Actions 会按 schedule 运行；也可在 Actions 页面手动 Run workflow 验证。

## 备份链路：cron-job.org 等外部服务（可选）

任意「定时 GET 一个 URL」的服务都可以：

1. URL 填 `https://你的域名/__cron`
2. 添加请求头 `X-Cron-Secret: <你的 CRON_SECRET>`（cron-job.org 在 Advanced 设置里支持自定义 header；不支持 header 的服务可用 `?key=<你的 CRON_SECRET>` 查询参数）
3. 调度频率建议 ≥ 前台「监控间隔」（更频繁也可以，防抖会自动跳过）

---

## 华为云函数工作流 FG（免费额度充足，推荐替代收费渠道）

部分云厂商的 Serverless 已开始对定时触发计费；华为云 FunctionGraph 目前免费额度
（每月约 100 万次调用 + 40 万 GB·秒）对「每 5 分钟触发一次」的场景绰绰有余。

### 配置步骤

1. 进入**函数工作流 FunctionGraph** → 创建函数 → 运行环境选 **Node.js 18 / 20**
2. 函数代码粘贴下方示例（入口为 `handler`）
3. 配置 → 环境变量，添加两项：
   - `CDT_URL` = `https://你的域名/__cron?source=huawei`
   - `CDT_SECRET` = 与 Worker 侧一致的 `CRON_SECRET`
4. 触发器 → **定时触发器（TIMER）**，Cron 表达式填 `0 */5 * * * *`
   （华为云为 6 位，依次为 秒 分 时 日 月 周；每 5 分钟一次）
5. 确保函数可访问公网（未绑定 VPC 时默认出网），保存并启用

> 管理台「定时监控配置 → 各渠道配置教程 ⑥」会自动按你填的域名、密钥、间隔生成
> 上面的 URL、Cron 表达式和完整代码，直接复制即可。

### 函数代码

```js
const https = require('https');

exports.handler = async (event, context) => {
  const url = process.env.CDT_URL || '';
  const secret = process.env.CDT_SECRET || '';
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'X-Cron-Secret': secret }, timeout: 60000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: body.slice(0, 200) }));
    });
    req.on('error', (e) => resolve({ statusCode: 500, body: String(e) }));
    req.on('timeout', () => { req.destroy(); resolve({ statusCode: 500, body: 'timeout' }); });
  });
};
```

### 验证

部署后回到管理台 → 设置 → 触发渠道，确认「华为云函数 FG」开关已打开，
点该行的**测试**按钮会强制跑一轮监控；稍后「上次触发时间」应刷新为「几秒前」。

---

## 关键：监控间隔如何配合

- **前台设置里的「监控间隔（分钟）」** 是 Worker 内部的**防抖阈值**
- **触发频率**（原生 Cron / 外部服务）是实际触发频率
- 触发频率高于监控间隔时，Worker 会自动跳过（防抖），不会重复执行

例如：
- 前台设「5 分钟」，原生 Cron 每 5 分钟 + GitHub Actions 每 5 分钟 → 仍然每 5 分钟监控一次（原子抢占保证不重复）✅
- 前台设「10 分钟」，触发每 5 分钟一次 → 每 10 分钟才真正执行 ✅

---

## 验证是否生效

1. **外部触发**：看 GitHub Actions 运行记录（cdt-monitor-trigger）是否成功；或手动：
   ```bash
   curl -H "X-Cron-Secret: 你的密钥" https://你的地址/__cron
   ```
   应返回 `{"monitored": N, "interval_minutes": 5}`（N 是账号数；`skipped: true` 表示刚运行过、被防抖跳过）。
2. **原生 Cron**：到 Dashboard → Worker → Logs（或 observability）看 `scheduled` 事件；也可回管理台「监控触发源」看「Cloudflare 原生 Cron」那行的「上次触发」时间戳是否在走动。
   若时间戳不动，先确认该渠道开关是否为「开」，以及「设置」页的监控间隔是否把执行频率降到了低于 5 分钟（那属于正常节流）。
3. **部署失败报 error 10072**：说明账号 Cron 额度用尽（`This account has reached the Workers Free limit of 5 cron triggers per account`）。
   删掉 `wrangler.toml` 中 `[triggers]` 段后重新部署（退回纯外部触发），或在 Dashboard 删除其他 Worker 的 cron 触发器腾额度、升级 Workers Paid。
4. 管理台「立即监控」按钮：已登录状态下点击即可，无需密钥。
   ```bash
   curl -H "X-Cron-Secret: 你的密钥" https://你的地址/__cron
   ```
   应返回 `{"monitored": N, "interval_minutes": 5}`（N 是账号数；`skipped: true` 表示刚运行过、被防抖跳过）。
3. 管理台「立即监控」按钮：已登录状态下点击即可，无需密钥。

---

## 常见问题

### Q1：外部请求 `/__cron` 返回 401？

- 未配置 `CRON_SECRET`：匿名外部请求一律 401，属预期行为。要么配置密钥，要么用管理台按钮手动触发。
- 已配置 `CRON_SECRET`：检查请求是否带上了 `X-Cron-Secret` 头（或 `?key=` 参数）且值一致。GitHub Actions 需确认仓库 secret 名称是 `CRON_SECRET`。

### Q2：触发返回 500 或报错？

- 检查 `CDT_MASTER_KEY` 是否已设置（43 位 base64）
- 检查是否已添加阿里云账号（没账号时返回 `monitored: 0` 是正常的）

### Q3：想临时手动触发一次监控？

用**管理台的「立即监控」按钮**（走管理员会话，已登录即可用）；
或已配置密钥时用上面 Q1 中的 curl 命令。
