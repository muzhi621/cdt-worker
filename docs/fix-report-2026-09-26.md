# 修复实施报告（2026-09-26）

> 依据《审计报告 audit-2026-09-26.md》与《修复方案 fix-plan-2026-09-26.md》，按"全按推荐"决策落地。
> **验证证据**：`vitest` 30/30 通过；`tsc --noEmit` 0 错误（见文末）。

---

## 一、已完成的修复

### Wave 1（必修）

| # | 问题 | 修复 | 涉及文件 |
| --- | --- | --- | --- |
| W1-1 | `CRON_SECRET` 鉴权与部署指引自相矛盾（启用即 401 停摆，不启用即公开） | **双通道重构**：① 启用原生 Cron Trigger（`[triggers] crons */5`），`scheduled()` 直调内部函数，无需密钥；② `/__cron` 改为"密钥 **或** 管理员会话"双通道放行；③ `cron.yml` 增加 `CRON_SECRET` GitHub secret 支持；④ `DEPLOY-CRON.md`/`README.md` 重写，删除"无需登录"过时说法 | `wrangler.toml`、`src/index.ts`、`src/http/server.ts`、`.github/workflows/cron.yml`、`DEPLOY-CRON.md`、`README.md` |
| W1-2 | `/__cron` 防抖非原子（读→判→写回，并发重复跑整轮） | 新增 `tryAcquireMonitorSlot()`：条件 UPSERT 单语句原子抢占 `last_monitor_run`，`meta.changes` + 回读双确认；防抖判断前置 + 抢占兜底，删除旧的 `markMonitorRun()` | `src/store/store.ts`、`src/http/server.ts` |
| W1-3 | 阿里云签名 `percentEncode` 误把 `%2B→%20`，参数含 `+` 时偶发 `SignatureDoesNotMatch` | 删除错误替换行（JS 的 `encodeURIComponent` 空格已是 `%20`、字面 `+` 应保持 `%2B`；该行是 Go 版对 `url.QueryEscape` 的补救被误搬） | `src/provider/aliyun.ts` |

### Wave 2

| # | 问题 | 修复 | 涉及文件 |
| --- | --- | --- | --- |
| W2-1 | CSRF token 从不校验 | 双提交 cookie 校验中间件：管理员会话 + 非 GET/HEAD/OPTIONS 请求时，`X-CDT-CSRF` 头必须与 `cdt_csrf` cookie 一致（常量时间比较）；API Key/Bearer 路径不受 CSRF 威胁故跳过。**配套前端**：页面刷新后从 cookie 恢复 token（此前 `csrf` 变量刷新即空，不补会全 403） | `src/http/server.ts`、`src/web/index.html` |
| W2-2 | `init-status` 无鉴权泄露 `envPasswordSet` | 接口不再返回该字段；改在**登录失败 401 响应**中附带 `env_password_available`（仅对尝试过登录者可见）；前端相应改读登录失败响应 | `src/http/server.ts`、`src/web/index.html` |
| W2-3 | `Unknown` 状态阻断新账号手动启停 | `engine.control` 仅阻断真正过渡态（`Starting`/`Stopping`/`Pending`），`Unknown` 放行 | `src/engine/engine.ts` |
| W2-4 | 内存限流 `rateMap` 无限增长 | 超过 500 条时清理已过期窗口的条目 | `src/http/server.ts` |
| W2-5 | SMTP 未真实冒烟 | 代码路径复核无误（`cloudflare:sockets` 在 `nodejs_compat` + compat date 2024-09-25 下可用）；真实冒烟转为**部署后手动清单**（见第三节） | — |

### Wave 3（低危批次）

| # | 问题 | 修复 | 涉及文件 |
| --- | --- | --- | --- |
| W3-1 | 登录限流仅内存级，跨 isolate 可绕过 | `login()` 增加 D1 计数限流：`login_attempts` 表查 15 分钟窗口内同 IP 失败次数 ≥ 8 即 429（与内存限流双保险；表由 `cleanupExpiredData` 定期清理） | `src/http/server.ts` |
| W3-2 | `ADMIN_PASSWORD` 后门持续有效无提示 | 环境变量密码登录成功后的审计日志追加"建议尽快删除 ADMIN_PASSWORD 环境变量"警示 | `src/http/server.ts` |
| W3-3 | `jobs` 死表无标注 | schema 中注明已废弃、被 `notification_outbox`/`billing_cache` 取代、勿在其上新增功能（保留建表语句防旧库报错） | `src/store/schema.ts` |
| W3-4 | 文档与实现脱节 | `DEPLOY-CRON.md`、`README.md`、`wrangler.toml`、`cron.yml` 四处同步为新架构 | 见 W1-1 |

### 顺手修复（测试驱动发现）

- `verifyPassword` 遇损坏的 base64 哈希段会抛 `InvalidCharacterError` 导致登录接口 500 → 改为降级返回 false（干净 401）。`src/security/security.ts`

### 测试建设

- 新增 `vitest`（`npm test`）与 4 组单测、**30 个用例**：
  - `test/aliyun-sign.test.ts` — percentEncode 语义（含 `+`/空格/`~`/`*`）+ `sign()` 与 Node 原生 HMAC-SHA1 交叉验证
  - `test/time-window.test.ts` — 2 小时窗口边界、跨午夜窗口、保活时段、时区账期（UTC 月初不错位）
  - `test/crypto.test.ts` — PBKDF2 往返、盐随机性、损坏哈希容错、常量时间比较
  - `test/billing-cache.test.ts` — TTL 命中/过期、UTC 时间戳解析、损坏 JSON 容错
- 为可测性重构：时间纯函数抽至 `src/engine/time.ts`（无 D1/cloudflare 依赖）；`percentEncode`/`sign` 导出。

## 二、按推荐**缓做**的事项

- **加密 AAD 绑定**（审计 #12）：需版本化迁移（`enc:v1:` → `enc:v2:`）且需重录全部账号密钥，收益低风险中，维持缓做。
- 阈值停机粘性键加时间维度、observability 关闭：维持现状（SameSite=Strict 已缓解 CSRF 残余面；可观测性收益大于成本）。

## 三、部署步骤（必读）

1. **重新部署**：`npm run deploy`（会自动注册 `[triggers]` 原生 Cron）。
2. **设置 Worker 密钥**：Dashboard → Worker → Settings → Variables and Secrets → 添加 `CRON_SECRET`（Secret 类型，值如 `openssl rand -hex 32`）。
3. **外部触发器同步**（若使用）：
   - GitHub Actions：仓库 Settings → Secrets → Actions → 添加 `CRON_SECRET`（与上一步同值），`cron.yml` 已自动带头发送。
   - cron-job.org 等：请求头加 `X-Cron-Secret: <值>`（或 URL 加 `?key=<值>`）。
4. **验证**：
   ```bash
   curl -H "X-Cron-Secret: <你的密钥>" https://你的域名/__cron   # 应返回 {"monitored":N,...}
   curl https://你的域名/__cron                                   # 应返回 401（预期行为）
   ```
5. 管理台登录后点「立即监控」应正常触发（走管理员会话通道）。
6. **刷新管理台页面后再做一次增删改操作**——确认 CSRF 双提交在刷新后仍通过（cookie 恢复逻辑生效）。

## 四、SMTP 手动冒烟清单（部署后执行）

1. 管理台「通知」页配置 SMTP（host/port/用户名/密码/发件人/收件人）→ 保存。
2. 点「发送测试」→ 检查收件箱（含垃圾箱）收到测试邮件。
3. 若失败，看「日志」页 error 分类中的具体 SMTP 响应（如 `535` 认证失败 / `Connection closed` 端口被墙）。
4. 465 端口（隐式 TLS）不通时尝试 587（STARTTLS）；Cloudflare Workers 出站 TCP 支持两者。

## 五、验证证据

```
$ npm test
 Test Files  4 passed (4)
      Tests  30 passed (30)

$ npx tsc --noEmit
（无输出，退出码 0）
```

---

## 六、追加修复：通知测试支持选择账号（2026-09-26 晚）

**问题**：「发送测试」永远只渲染第一个账号的内容（`notifyTestHandler` 写死 `config.accounts[0]`）。

**修复**：
- 后端 `/api/v1/notify/test` 接受可选 `accountId`，指定则用该账号渲染示例，账号不存在返回 404（`src/http/server.ts`）；
- 前端「通知渠道」页顶部新增「测试通知使用的账号」下拉框，随配置加载自动填充，测试按钮携带所选账号（`src/web/index.html`）。

**真实告警链路排查结论**：
- 通知层按事件隔离：每个告警事件只携带触发它的那个账号的字段；SMTP/Webhook/Telegram 等发送函数无共享状态，代码层面不存在跨账号串号。
- 易造成"只有第一个账号"观感的设计：**阈值告警是粘性一次性**（幂等键 `threshold:{id}:active`，账号超阈值只发一次，用量降回阈值以下才复位）——不会重复刷屏，也不会"只发第一个账号"。
- 为便于生产核对，`flushOutbox` 每次成功投递新增日志：`通知已投递 [事件标题 · 账号#id]`（日志页"全部"分类可见）。部署后如仍发现某条通知内容与账号不符，把该日志与收到的消息对照反馈，再进一步深挖。
- 注意：outbox 每监控周期最多投递 10 条（多于 10 条时分批），账号数 >10 且同轮全部告警时属预期。
