# 监控定时触发配置（外部触发为主，原生 Cron 可选）

> CDT-Monitor Worker 版现在使用**双链路**定时触发，默认启用的是外部触发：
> 1. **主链路（默认）**：外部定时服务（cron-job.org / GitHub Actions 等）请求 `/__cron`，需携带 `CRON_SECRET`；
> 2. **可选增强**：Cloudflare 原生 Cron Trigger（`wrangler.toml` 的 `[triggers]`），`scheduled()` 直调内部监控函数，**无需密钥**。
>
> 两条链路共用 Worker 内部防抖（前台「监控间隔」分钟数）+ 原子槽位抢占，
> 无论多少个触发源同时打过来，同一防抖窗口内只有一轮监控真正执行。
>
> ⚠️ **为什么原生 Cron 默认关闭**：Cloudflare 免费版每个账号只有 **5 个 Cron Trigger**
> 额度。若账号额度已用尽，`wrangler deploy` 会在注册 cron 时直接失败并报
> `error 10072`，导致整个部署中断（代码已上传但触发器配置回滚失败）。

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

## 主链路：外部触发 `/__cron`（已默认启用）

`wrangler.toml` **不包含** `[triggers]` 段，外部服务定时请求 `/__cron` 即可：

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

## 可选增强：原生 Cron Trigger（需账号有余量才建议开启）

确认额度充足后再启用（Dashboard → Workers → 任一 Worker 的 Triggers 页可见已用数量）：

```toml
[triggers]
crons = ["*/5 * * * *"]
```

去掉 `wrangler.toml` 中该段的注释即可，重新 `wrangler deploy` 后 `scheduled()`
接管调度（不经过 HTTP 层，无需密钥）。外部触发链路同时保持可用。
升级到 Workers Paid（$5/月）后额度提升到 1000，可放心开启。

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
2. **原生 Cron**（仅开启时）：到 Dashboard → Worker → Logs（或 observability）看 `scheduled` 事件；也可回管理台「日志」页看 `heartbeat` 监控日志。
3. **部署失败报 error 10072**：说明账号 Cron 额度用尽（`This account has reached the Workers Free limit of 5 cron triggers per account`）。
   确认 `wrangler.toml` 中 `[triggers]` 段已注释掉后重新部署；或在 Dashboard 删除其他 Worker 的 cron 触发器、升级 Workers Paid。
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
