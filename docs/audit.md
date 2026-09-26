# CDT Monitor 系统级审计结论

> 审计对象：Cloudflare Workers + D1（cdt-worker），Free 计划
> 结论基于源码复核（server.ts / engine.ts / store.ts / security.ts / schema.ts / aliyun.ts / wrangler.toml / cron.yml）

## 一、额度优化（含估算）

按 `monitorInterval=5min` → 288 次监控/天，N=账号数：

- **D1 写行/天 ≈ 1104N + 576**（heartbeat 288N + 账单缓存 288N + updateRuntime/traffic_stat 各约168N + 账单 info 日志 144N + 周期 info/markMonitorRun 各288 + schedule 幂等键 48N）。N=5≈6千行（6%额度），N=50≈5.6万行（56%），**当前安全，主要杠杆在日志啰嗦度**。
- **D1 读行/天**：每周期 `getConfig`（settings 11 行 + accounts N 行）+ 每账号账单/幂等读；N=50 也仅 ~6万行，远低于 500万，**非瓶颈**。
- **真正的用量风险不在正常监控，而在 `/__cron` 被滥用**（见安全 P1）。
- **可省点（改动极小）**：`runMonitorCycle` 先 `getConfig`（读全量 settings + 解密全部 AK/SK，2N 次 AES importKey+decrypt）**再防抖** → 每次被跳过的触发也白耗 CPU + 2 次 D1 读。应**先防抖后 getConfig**：单条查询读 `last_monitor_run + monitor_interval`，命中才加载配置。
- `traffic_stats`/`action_events`/`login_attempts`/`sessions` 无限增长（见架构）。

## 二、安全漏洞（按严重度）

**P0：无**（未发现凭据明文泄露或未授权数据读取路径，AK/SK 已 AES-GCM 加密）。

**P1**
1. **`/__cron` 无鉴权 + 无限流 + 竞态**：`/__cron` 绕过全部鉴权与 rateMap，任何人可触发。每次触发都实打实跑 `getConfig`（2 D1 读 + 2N 次解密 CPU）；且 `markMonitorRun` 在周期**末尾**才写，并发触发会**同时通过防抖**，放大为 N 次完整监控（多倍阿里云 API 调用 + 写行）。持续打可耗尽 10万请求/天、D1 读配额、阿里云 AK 限流 → 监控停摆（DoS）。**修复**：加共享密钥头（`X-Cron-Secret`）+ 周期开始**原子抢占** `last_monitor_run`（条件 UPDATE，0 行即跳过）。
2. **`ADMIN_PASSWORD` 永久后门**：登录成功后虽回写 D1 哈希，但 Secret 仍在，静态密码永远绕过 D1 哈希；且**<10 位也能登录**（只是不同步哈希）。修复：登录同步后提示用户**删除该 Secret**。
3. **`clientIP` 信任 `X-Forwarded-For`**：攻击者伪造 XFF 可绕过 login/passwd 限流、伪造审计日志 IP。修复：优先 `CF-Connecting-IP`，忽略 XFF（自建域下无需）。

**P2**
1. **CSRF token 从不校验**：`cdt_csrf`/`X-CDT-CSRF` 是死代码，仅靠 session cookie `SameSite=Strict` 兜底。**若 `*.workers.dev` 路由未关闭**，SameSite 是"站点级"而非"源级"，恶意 sibling `workers.dev` 应用可发起同站跨源 POST 触发副作用。修复：鉴权中间件真正校验 token，或关闭 workers.dev 路由仅留自建域。
2. **session 不校验 ip/user_agent**：会话被盗用不易察觉（token 本身 256 位随机，风险低）。
3. **`/api/v1/system/init-status` 无鉴权**泄露 `initialized` + `envPasswordSet` 布尔。
4. **限流内存 Map 仅单 isolate 有效**：冷启动/多 isolate 下 login 限流可绕过（结合 XFF 伪造更易）。
5. **SSRF（低危）**：webhook/telegram proxy URL 由 admin 配置、服务端 fetch，仅 admin 可触达。
6. **加密缺 AAD**：密文未绑定 account_id，有 DB 写权限者可跨账号互换密文（低危）。

## 三、架构隐患

1. **`scheduled()` 已实现却未启用**：为绕开"5 Cron/账号"限制改用外部 GitHub Actions + 公开 `/__cron`，引入外部依赖 + DoS 面。**实际只需 1 个原生 Cron Trigger**（≪5），应改回原生 Cron，`/__cron` 降级为受保护的手动触发。
2. **防抖竞态**：`last_monitor_run` 在周期末尾才写，并发/慢周期下会双重运行（重复写行、重复调阿里云、可能重复告警——阈值/定时/保活动作虽被 action_events 幂等兜住，但 traffic_stat/heartbeat 会重复）。
3. **数据无限增长**：`traffic_stats`（前端只用 720 条）、`action_events` 的 `schedule:*`/`keepalive:*` 键（分钟粒度、只增不删）、`login_attempts`、`sessions`（自然过期不清理）均无清理，D1 500MB 缓慢耗尽；仅 `logs` 有 retention。`jobs` 为死表。
4. `[observability] enabled=true`（20万日志/天）在 `/__cron` 被滥用时也会放大日志量（正常用量无虞）。

## 四、建议修复清单（优先级 / 改动量）

1. **[P1] `/__cron` 加固**：加 `X-Cron-Secret` 共享密钥校验 + 周期开始原子抢占防抖（`store.shouldRunMonitor` 改条件 UPDATE）——小改动（server.ts + store.ts）。
2. **[P1] 关闭 ADMIN_PASSWORD 后门**：文档/运维提示删除 Secret——极微。
3. **[P1] 修复 `clientIP` XFF 信任**——微（server.ts 1 行）。
4. **[P2] 校验 CSRF token**：`X-CDT-CSRF` vs `cdt_csrf` cookie 比对中间件——小（server.ts）。
5. **[P2] 建立清理机制**：traffic_stats 按账号保留最近 720/30 天、action_events 删旧键、login_attempts/sessions 清理过期——中（store.ts + engine.ts 顺带执行）。
6. **[P2] 启用原生 Cron**：wrangler.toml 加单个 cron trigger，`/__cron` 仅保留受保护手动入口——小。
7. **[P2] 顺带**：删除死表 `jobs`；`getConfig` 前移防抖（与 #1 合并）。
