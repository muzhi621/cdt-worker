# CDT-Monitor Worker 系统架构与代码审计报告

> 审计日期：2026-09-27　·　审计范围：`cdt-worker`（Cloudflare Worker 版 CDT-Monitor）
> 代码基线：`dfa1dd2`　·　交付形式：架构说明 + 功能点清单 + 三级问题清单 + 优化路线图

---

## 〇、执行摘要

| 维度 | 结论 |
|---|---|
| **架构形态** | 模块化单体（Modular Monolith）+ Serverless 单函数。分层清晰（http / engine / provider / store / notify / security），层间单向依赖，无循环依赖。**这是正确选择，无需微服务化。** |
| **规模** | 后端 3,330 行 TS（11 文件）+ 前端 2,783 行单文件 SPA + schema 126 行。单人/小团队可完整掌控。 |
| **功能完整度** | 监控、定时、保活、阈值、通知、账单、多触发源、教程已闭环；但存在 **3 处"能力宣称与实际不符"**（见 🔴-2、🟠-9、🟠-12）。 |
| **性能风险** | 真实瓶颈是 **CPU（Free 计划 10ms/请求）**，不是 D1 额度。3 处高频重复 `importKey` + 日志页 `new Intl.DateTimeFormat` × 50/页 + heartbeat 日志策略回退。 |
| **免费额度** | D1 读写/请求/存储均在 1%~6% 水位，**不会超限**；真正会出问题的是 CPU 与阿里云 RPC 侧的无限流。 |
| **安全问题** | 无 SQL 注入、无 XSS（前端 100% `esc()` 转义）、CSRF/PBTF2/登录限流已补。**剩余 2 处实质性风险**：`refresh` 无限流、`ADMIN_PASSWORD` 短密码不回写导致密码体系割裂。 |
| **测试** | 44 用例覆盖纯函数（time / 签名 / 触发源 / 加密 / 账单缓存），**引擎与数据层 0 覆盖**。 |

**一句话建议**：架构骨架已经很好，接下来不是"重构"，而是**补 3 个功能缺口 + 修 4 个性能点 + 关掉 2 个后门级风险**，全部是小时级工作量。

---

## 一、系统全景

### 1.1 运行时拓扑

```
                 ┌─ 触发源 A: GitHub Actions (.github/workflows/cron.yml)
                 ├─ 触发源 B: cron-job.org / 自建驱动 → GET /__cron?source=http|selfhost
 [外部定时服务] ──┼─ 触发源 C: 腾讯云 SCF   → ?source=tencent
                 ├─ 触发源 D: 阿里云 FC    → ?source=aliyun
                 └─（无 CF 原生 Cron：scheduled() 已移除，见下方说明）
                                    │  携带 X-Cron-Secret（constantTimeEqual 校验）
                                    ▼
                          ┌─────────────────────┐
   [浏览器 SPA] ──HTTPS──▶ │  Cloudflare Worker  │
   (src/web/index.html)   │  src/index.ts       │
                          └─────────┬───────────┘
                                    │
                 ┌──────────────────┼──────────────────┐
                 ▼                  ▼                  ▼
          ┌─────────────┐   ┌──────────────┐   ┌───────────────┐
          │  D1 (SQLite)│   │ 阿里云 OpenAPI│   │ 通知通道外呼  │
          │ settings /  │   │ CDT / ECS /  │   │ TG / Webhook /│
          │ accounts /  │   │ BSS 账单      │   │ Server酱/PP/  │
          │ logs /      │   │ HMAC-SHA1    │   │ SMTP(TCP 465) │
          │ action_events│  │ RPC 签名      │   └───────────────┘
          │ outbox /    │   └──────────────┘
          │ sessions /  │
          │ billing_cache│
          └─────────────┘
```

**关键事实**：Worker 是**无状态**的，全部状态在 D1；调度靠"外部推"，不靠 Worker 自身常驻；因此**没有任何一台服务器**，也没有单点。

### 1.2 分层与依赖方向

```
┌───────────────────────────────────────────────────────────┐
│ 接入层  src/index.ts            Worker 入口（仅 fetch）│
│         src/http/server.ts      路由表 / 鉴权 / CSRF / 错误处理 │
├───────────────────────────────────────────────────────────┤
│ 引擎层  src/engine/engine.ts    监控循环、策略判定、通知编排      │
│         src/engine/time.ts      时区纯函数（已缓存 formatter）   │
│         src/engine/triggers.ts  触发源定义/解析/断档判定（纯函数）│
│         src/engine/selfhost.ts  自托管驱动脚本模板生成           │
├───────────────────────────────────────────────────────────┤
│ 适配层  src/provider/aliyun.ts  RPC 签名 + CDT/ECS/BSS 接口      │
│         src/notify/service.ts   5 通道投递 + 模板渲染            │
│         src/notify/smtp.ts      Raw TCP SMTP 客户端             │
├───────────────────────────────────────────────────────────┤
│ 数据层  src/store/store.ts      全部 D1 读写（唯一 SQL 出口）     │
│         src/store/schema.ts     幂等建表 + 迁移 + 默认配置        │
├───────────────────────────────────────────────────────────┤
│ 安全层  src/security/security.ts AES-GCM / PBKDF2 / Token/CSRF  │
└───────────────────────────────────────────────────────────┘
         只向下依赖，无反向依赖，符合分层单体最佳实践
```

**评价**：这条依赖链非常干净。`store.ts` 是唯一 SQL 出口，`time.ts` / `triggers.ts` / `provider/aliyun.ts::sign` 是零依赖纯函数（所以能单测）——这两个设计决策让 44 个单测能零成本覆盖核心逻辑，值得肯定。

---

## 二、功能点清单（细化到可执行单元）

> 编号规则：`<域><序号>`。每个功能点标注「输入 → 处理 → 落库/外呼 →  Observability」。

### A. 接入与调度层（Trigger & Bootstrapping）

| 编号 | 功能点 | 位置 | 说明 |
|---|---|---|---|
| A1 | 首次请求自动建表 | `index.ts:8-19` | `ensureSchema` 幂等（进程内 `schemaReady` 标记），失败返回 `schema_init_failed` 而非崩溃 |
| A2 | 原生 Cron 入口 | `index.ts:25-36` | 受 `sources.native` 开关控制；关闭时 `noteTriggerDisabled` 留痕 |
| A3 | `/__cron` HTTP 入口 | `server.ts:599-636` | 双通道鉴权：`X-Cron-Secret`/`?key=`（constantTime）或管理员会话 |
| A4 | 触发源身份识别 | `triggers.ts:34-42` | `?source=` 或 `X-Trigger-Source`，未声明归 `http`；含 15 个别名映射 |
| A5 | 渠道开关判定 | `server.ts:621-634` | 关闭 → `{skipped:true, reason:'source_disabled'}`，不执行监控 |
| A6 | 上次触发时间记录 | `store.ts:137-148` | `touchTriggerSource(env, src, now, seen)` 复用已读状态，避免读-改-写 |
| A7 | 断档告警 | `server.ts:808-823` | 已启用渠道超 30 分钟未触发 → 每小时至多一条 `warning` |
| A8 | 轻量防抖 | `server.ts:834-840` | 先查 `monitor_interval`+`last_monitor_run`，未到点直接返回，跳过全量 `getConfig` |
| A9 | 原子槽位抢占 | `store.ts:92-104` | 条件 UPSERT 单语句抢占，并发触发只有一轮真正执行 |
| A10 | 强制绕过防抖 | `server.ts:785,442` | `force=true`（测试渠道 / 手动刷新） |
| A11 | 静态首页 + ETag | `server.ts:24-30, 643-651` | SHA-256 ETag，命中 304 省出网与 CPU |
| A12 | 健康检查 | `server.ts:111-115` | `/healthz`、`/readyz`（D1 探活） |

### B. 认证与授权（AuthN / AuthZ）

| 编号 | 功能点 | 位置 | 说明 |
|---|---|---|---|
| B1 | 初始化状态查询 | `server.ts:120-122` | **只返回 `initialized`**，不泄露 `envPasswordSet` |
| B2 | 系统初始化 | `server.ts:147-162` | 密码 ≥10 位 → PBKDF2 → 写 D1 → 建会话 |
| B3 | 登录（三层限流） | `server.ts:182-239` | ① 内存 8 次/15min ② D1 计数 8 次/15min ③ PBKDF2 校验 |
| B4 | 会话创建 | `server.ts:298-306` | 24h，`tokenHash` 存库，cookie 明文 token + HttpOnly |
| B5 | CSRF 双提交 | `server.ts:663-671` | 仅"管理员会话 + 非幂等方法"；API Key 免疫（无副作用 Cookie） |
| B6 | 修改密码 + 会话吊销 | `server.ts:242-282` | 改密后删除其他会话，保留当前 |
| B7 | 退出登录 | `server.ts:284-296` | 删除会话行 + 双 Set-Cookie 清标 |
| B8 | 身份认证 | `server.ts:77-107` | API Key（SHA-256 比对）或 Session；admin 角色固定 scopes 全给 |
| B9 | 客户端 IP 提取 | `server.ts:43-51` | 优先 `CF-Connecting-IP`（不可伪造），XFF 仅兜底 |
| B10 | ~~API Key 管理~~ | `server.ts:83-95` | **🔴 死功能**：`api_keys` 表与校验分支存在，但**无任何创建/吊销接口**，三个 scope 实际无人可用 |

### C. 账号管理

| 编号 | 功能点 | 位置 | 说明 |
|---|---|---|---|
| C1 | 新增账号 | `store.ts:272-280` | AK/SK 加密后入库；`name` 兜底为脱敏 AK |
| C2 | 更新账号配置 | `store.ts:287-305` | 动态 SQL，AK/SK 传空则不覆盖 |
| C3 | 删除账号 | `store.ts:282-284` | 依赖 `FOREIGN KEY ... ON DELETE CASCADE` 清理 `traffic_stats` |
| C4 | 配置读取与脱敏 | `server.ts:326-356` | Secret 不回传，只回 `xxxConfigured` 标志 |
| C5 | 通知密钥继承 | `server.ts:359-376` | 保存时空串继承旧值，`configured` 标志不落库 |
| C6 | ~~账号级保活~~ | `store.ts:243` | **🟠 死字段**：`accounts.keep_alive` 读写都有，但引擎只判断全局 `config.keepAlive` |

### D. 监控引擎（核心业务）

| 编号 | 功能点 | 位置 | 说明 |
|---|---|---|---|
| D1 | 定时窗口判定 | `time.ts:73-86` | `dueWithin`，2h 容忍窗口，支持跨午夜回拨 24h |
| D2 | 定时幂等键 | `engine.ts:357-380` | `schedule:{id}:{YYYYMMDD}:{action}:{HH:mm}`（含跨午夜日期回退） |
| D3 | 定时执行 | `engine.ts:350-402` | 失败 → 删键 → 下轮自动重试 |
| D4 | 刷新频率判定 | `engine.ts:149-153` | `due = force ∨ 超时 ∨ 整点 ∨ 状态刚变化` |
| D5 | 流量/状态并行查询 | `engine.ts:158-161` | `Promise.allSettled`，单失败不影响另一路 |
| D6 | 阈值检测 + 去抖 | `engine.ts:185-229` | 键 `threshold:{id}:active`，**仅在 `due` 周期清理** |
| D7 | 阈值停机 | `engine.ts:205-215` | `stop_and_notify` 且非 Stopped/Stopping 时执行 |
| D8 | 错过关机窗口补偿 | `engine.ts:238-252` | `stopWindowOver` + 幂等键复用，当日只补一次 |
| D9 | 保活 | `engine.ts:255-277` | 分钟级幂等键，Stopped 且在运行时段内自动拉起 |
| D10 | 账单刷新 | `engine.ts:280-312` | 余额/账单各 TTL 10 分钟；账单无数据回退账号级 |
| D11 | 状态变化通知 | `engine.ts:317-340` | 仅 Running↔Stopped 稳定态；`enableStatusChangeNotify` 开关 |
| D12 | heartbeat 日志 | `engine.ts:344-346` | ⚠️ **本轮改动后回退为"每刷新周期每账号一条"** |
| D13 | 汇总视图 | `engine.ts:432-474` | 聚合状态/流量/阈值/余额/成本 |
| D14 | 手动控制 | `engine.ts:405-429` | 阻断过渡态；保活开启时禁止手动关机 |

### E. 阿里云适配层

| 编号 | 功能点 | 位置 | 说明 |
|---|---|---|---|
| E1 | RFC3986 编码 | `aliyun.ts:40-44` | 注意：不复用 Go 的 `+`→` ` 补救，避免 `SignatureDoesNotMatch` |
| E2 | HMAC-SHA1 签名 | `aliyun.ts:47-65` | 排序 + 拼串 + base64 |
| E3 | RPC 调用与重试 | `aliyun.ts:73-96` | 指数退避；仅 5xx/429/throttling 重试 |
| E4 | CDT 流量查询 | `aliyun.ts:201-224` | 按地域分类累加，字节 → GB |
| E5 | 实例状态查询 | `aliyun.ts:227-244` | 多实例取首个；空数组返回 `Unknown` |
| E6 | 启停控制 | `aliyun.ts:247-271` | Stop 时传 `StoppedMode`（节省/普通停机） |
| E7 | 账户余额 | `aliyun.ts:274-291` | 按 `siteType` 选 BSS endpoint |
| E8 | 实例账单 | `aliyun.ts:294-338` | 分页最多 3 页，`NextToken` 续拉 |

### F. 通知层

| 编号 | 功能点 | 位置 | 说明 |
|---|---|---|---|
| F1 | 事件模型 | `notify/service.ts:7-15` | id/type/title/summary/accountId/fields/createdAt |
| F2 | 通道可用性判定 | `service.ts:38-46` | `activeChannels`，必填项齐全才算启用 |
| F3 | 自定义模板 | `service.ts:28-35` | `{{变量名}}` 替换，留空用默认 |
| F4 | Telegram | `service.ts:54-69` | 支持自定义反代 `proxyUrl` |
| F5 | 通用 Webhook | `service.ts:71-104` | GET/POST、JSON/FORM、自定义 headers |
| F6 | Server酱 Turbo | `service.ts:107-119` | 校验 `code === 0` |
| F7 | PushPlus | `service.ts:122-136` | HTML 模板 + escapeHtml |
| F8 | SMTP 直投 | `smtp.ts:82-122` | Raw TCP，AUTH LOGIN，主题 RFC2047 base64 |
| F9 | Outbox 入队 | `store.ts:502-506` | `available_at = unixepoch()` |
| F10 | Outbox 消费 | `engine.ts:479-511` | 每轮最多 10 条；全成功 → sent；部分失败 → 5min 后重试，24h 放弃 |
| F11 | 测试通知 | `server.ts:494-554` | 支持指定 `accountId`（此前的 Bug 已修） |

### G. 前端设置页（已重组的触发源区域）

| 编号 | 功能点 | 位置（`src/web/index.html`） |
|---|---|---|
| G1 | 5 Tab SPA（状态/账号/设置/通知/日志） | 792-1010 |
| G2 | 教程变量抽象 `tutorialVars()`（域名默认 `location.origin`） | ~2330 |
| G3 | 5 渠道教程渲染 `renderTutorial()` | ~2362 |
| G4 | 滑动开关 `.toggle-switch` 替代 checkbox | CSS ~490 |
| G5 | 渠道测试按钮（后端 1 分钟限流） | ~2240 |
| G6 | 自建驱动/一键命令下载（事件委托复制） | ~2600 |
| G7 | 深浅主题切换 + 移动端底部导航 | ~783-820 |

### H. 日志与运维

| 编号 | 功能点 | 位置 |
|---|---|---|
| H1 | 分类日志（auth/monitor/alert/all） | `store.ts:337-383` |
| H2 | 分页查询（≤100 条/页，白名单类型映射，全参数化） | `store.ts:351-383` |
| H3 | UTC → 配置时区展示 | `server.ts:471-485`（⚠️ 见 🟠-6） |
| H4 | 分类清空 | `store.ts:385-393` |
| H5 | 过期清理（5 张表） | `store.ts:399-436` |
| H6 | 每天一次门控 | `server.ts:876-882`（`cleanup:YYYYMMDD`） |

### I. 数据模型

| 表 | 用途 | 状态 |
|---|---|---|
| `settings` | 全部配置 KV（含 `trigger_sources`/`trigger_seen`/`notifications`） | -active，但 `getConfig` 全表扫描 |
| `accounts` | 被监控账号，AK/SK 加密列 | -active |
| `traffic_stats` | 流量采样（供趋势图） | -active |
| `logs` | 全量日志 | -active，增长最快 |
| `action_events` | 幂等键中心 | -active |
| `notification_outbox` | 通知队列 | -active |
| `billing_cache` | 余额/账单缓存 | -active |
| `sessions` | 管理员会话 | -active |
| `login_attempts` | 登录失败计数 | -active |
| `api_keys` | API Key | **-未接线（死表）** |
| `jobs` | 旧任务队列 | **-死表，代码零引用** |

---

## 三、关键链路时序

### 3.1 一次监控周期（`/__cron`，5 账号）

```
外部服务 ──GET /__cron?source=github (X-Cron-Secret)──▶ Worker
   │
   ├─[1] 鉴权：constantTimeEqual(secret, provided)
   ├─[2] 渠道开关：sources[source] ? 继续 : skipped
   ├─[3] touchTriggerSource  ← 1× D1 读 + 1× D1 写
   ├─[4] runMonitorCycle(force=false, state)
   │      ├─ getMonitorState            1× 读
   │      ├─ checkTriggerGaps           6× 读（action_events 探键）
   │      ├─ tryAcquireMonitorSlot      1× 写 + 可能 1× 回读
   │      ├─ getConfig    → 读全表 settings + listAccounts（N× AES 解密）
   │      ├─ for batch(5):
   │      │     processAccount × 5（并发）
   │      │       ├─ due? → 2× 阿里云 RPC（并行）+ updateRuntime + traffic_stats
   │      │       ├─ 阈值 / 补偿 / 保活 / 账单 各 0-1 次 D1 写
   │      │       └─ heartbeat log
   │      ├─ flushOutbox               ≤10× 投递 + N× D1 写
   │      └─ cleanup（每天首轮）        4× DELETE
   └─[5] 返回 {monitored, interval_minutes}
```

**单轮 D1 操作量（5 账号默认）**：读约 8-14 次、写约 12-20 次；288 轮/天 → **读 ~3k/天、写 ~5k/天**，相对 D1 免费额度（每天 100k 读 / 50k 写 / 100k 请求）水位仅 **3%~10%**。**额度不是问题。**

### 3.2 通知投递链路

```
策略判定（阈值/状态变化/定时/保活）
  → store.addOutbox（写）
  → 周期末尾 flushOutbox：listPendingOutbox(10)
       → deliverEvent → 串行遍历已启用通道
       → 全成功 markOutboxSent + 一条 info
       → 部分失败 markOutboxRetry（available_at +300s，>24h 转 failed）
```

---

## 四、架构决策记录（ADR 摘录）

| 编号 | 决策 | 理由 | 代价 |
|---|---|---|---|
| ADR-01 | 用外部 HTTP 触发（`/__cron`）替代 CF 原生 Cron 作为默认 | 免费账号仅 5 个 Cron 额度，启用会触发 error 10072 致部署失败 | 需自维 CRON_SECRET 与冗余渠道 |
| ADR-02 | 模块化单体，不分服务 | 单人维护、边界清晰、无需运维 | 规模增长后需自律模块边界 |
| ADR-03 | 状态全放 D1，Worker 无状态 | Serverless 多 isolate，内存不可信 | 每个周期多次 D1 往返 |
| ADR-04 | 幂等键放 `action_events` 表 | 免费额度内最省的方案，天然去重 | 键需设计好时间维度（已处理跨午夜） |
| ADR-05 | 条件 UPSERT 做原子防抖 | 并发触发时只有一轮执行 | 依赖 D1 `meta.changes` |
| ADR-06 | PBKDF2 代替 Argon2id | Worker 无原生 Argon2 | 计算量高于 Argon2（见 🟠-5） |
| ADR-07 | SMTP 走 Raw TCP 465 | Workers 已封 25/587 部分场景，465 implicit TLS 最稳 | 需 `cloudflare:sockets`，调试难 |

---

## 五、代码审计（三级问题清单）

> 格式为「位置 / 问题 / 影响 / 建议」。

### 🔴 阻塞级（必须修）

**🔴-1　`refresh` 接口无任何限流，可无限打阿里云 RPC**
- 位置：`server.ts:437-444` → `engine.processAccount(env, account, true)`
- 问题：这是 **force 执行**，绕过 `runMonitorCycle` 里的防抖与 `tryAcquireMonitorSlot`。连点 20 次 = 20 轮真实阿里云调用 + 20× 通知写入。
- 影响：阿里云侧 `Throttling.User` 限流（进而污染所有账号）、通知通道被打爆、单请求 CPU 可能撞 Free 计划上限被终止。
- 建议：复用 `testTrigger` 的 `action_events` 分钟级键做单账号节流：

```ts
async function refresh(ctx: Context): Promise<Response> {
  const id = parseInt(ctx.params.id, 10);
  const minuteKey = `refresh:${id}:${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
  if (!(await store.recordActionEvent(ctx.env, minuteKey, id, 'refresh', 'attempting', ''))) {
    return error('too_many_requests', '刷新过于频繁，请 1 分钟后再试', 429);
  }
  // ...原有逻辑
}
```

---

**🔴-2　API Key 体系是"死功能"**
- 位置：`store/schema.ts:96-105`（建表）、`server.ts:83-95`（校验分支）、路由表里的 `widget:read` / `instance:control` scope
- 问题：`api_keys` 表存在、校验逻辑存在，但**全代码库没有任何创建/列举/吊销 API Key 的接口**（已 grep 确认）。
- 影响：`/api/v1/status`、`/api/v1/widget/summary`、`/api/v1/accounts/:id/history` 这三个接口对外宣称可由 API Key 访问，实际**没有任何密钥能访问**；`instance:control` scope 同理。功能宣称与实际不符。
- 建议：二选一 ——
  - **方案 A（推荐，成本 0.5 天）**：补 `GET/POST /api/v1/system/api-keys` + `DELETE .../:id`，在"设置"页加管理 UI。
  - **方案 B（成本 0.2 天）**：删除 `authenticate` 的 API Key 分支与 `api_keys` 表，路由表 scope 只保留 `admin`，避免误导。

---

**🔴-3　`ADMIN_PASSWORD` 短密码登录不回写哈希，造成双密码体系**
- 位置：`server.ts:222-232`
- 问题：用 env 密码登录后，仅当 `password.length >= 10` 才回写 D1 哈希；长度不足时只记一条日志。此时 D1 里仍是**旧哈希**。
- 影响：用户以为密码已更新，实际下次用**旧密码**照样能登录成功。这是一个可被利用的"影子后门"，且用户完全不可见。
- 建议：两种收敛方式（任选其一，我推荐前者）：
  ```ts
  // 推荐：env 密码登录后一律强制回写（长度不足则拒绝登录并提示）
  if (viaEnvPassword) {
    if (password.length < 10) {
      return error('weak_env_password',
        'ADMIN_PASSWORD 长度不足 10 位，拒绝使用该凭据登录；请到 Cloudflare Dashboard 修改 ADMIN_PASSWORD 为 10 位以上后重试。', 400);
    }
    await store.setPasswordHash(ctx.env, await hashPassword(password));
    await store.addLog(ctx.env, 'audit', '使用 ADMIN_PASSWORD 登录成功，密码已同步至 D1，请尽快删除该环境变量');
  }
  ```

---

**🔴-4　`processAccount` 修改入参对象，污染调用方持有的 config**
- 位置：`engine.ts:245` `account.instanceStatus = StatusStopping;`
- 问题：`account` 来自 `config.accounts`，`config` 由 `runMonitorCycle` 持有并**在批次间共享**。`processAccount` 直接改它。
- 影响：虽然本轮已用 `previousStatus` 兜底，但对象被隐式修改属于典型副作用；当前 5 账号分批共享同一 config，未来若复用 config 做通知/汇总会读到被改过的状态。
- 建议：改为局部变量 `let viewStatus = status;`，不要在入参上写。

---

### 🟠 重要（性能 / 一致性 / 健壮性）

| 编号 | 位置 | 问题 / 影响 / 建议 |
|---|---|---|
| 🟠-5 | `security.ts:78` | **PBKDF2 60,000 迭代**：单次登录的 CPU 消耗（数十毫秒量级）很可能**超过 Free 计划 10ms/请求上限**，导致登录请求被 Cloudflare 直接终止（表现为"偶尔登录失败/超时"）。建议降到 `12,000` 迭代（哈希串已存 `i=`，可平滑迁移），并实测 `crypto.subtle.deriveBits` 耗时后再定。 |
| 🟠-6 | `server.ts:476-480` | **日志页每条都 `new Intl.DateTimeFormat`**：50 条/页 = 50 次毫秒级构造，且没有走 `time.ts` 的 formatter 缓存。建议导出复用：<br>`export function formatInTimezone(date, tz)` 复用 `formatterCache`。 |
| 🟠-7 | `security.ts:32-34`、`aliyun.ts:56-62` | **每次加/解密都 `crypto.subtle.importKey`**：一轮监控产生约 10 次 AES importKey + 10 次 HMAC importKey。建议按 material 缓存 `CryptoKey`（isolate 内有效）：<br>`const keyCache = new Map<string, CryptoKey>()`，命中则 `Promise.resolve(cached)`。 |
| 🟠-8 | `engine.ts:344-346` | **heartbeat 策略回退**：为修复"看不到心跳"改为每刷新周期每账号写一条 → 5 账号 × 288 轮 = **1440 条/天**（此前降频策略是 480 条/天）。建议改为**周期级一条汇总**：在 `runMonitorCycle` 末尾写一条 `info`，`processAccount` 里只在「有动作或状态变化」时才写 heartbeat，日志页即可同时看到心跳与关键事件。 |
| 🟠-9 | `store.ts:243` | **`accounts.keep_alive` 是死字段**：写入、前端表单提交、D1 读取都有，但 `engine.processAccount` 只判断全局 `config.keepAlive`。账号级保活开关点了不生效。建议：要么引擎读 `account.keepAlive` 做 AND 判定，要么从表单移除。 |
| 🟠-10 | `server.ts:461-465` | **日志接口为拿时区调 `getConfig`**：触发一次全表 settings 读取 + N 次 AES 解密，只为取一个 `timezone` 字符串。建议新增 `getSetting(env, 'timezone')` 单行查询。 |
| 🟠-11 | `store.ts:369` | **`COUNT(*)` 全表统计**：`logs` 会增长到数万行，每次翻页一次全表计数（SELECT COUNT 无索引下界优化）。建议改为 `SELECT COUNT(*) FROM (SELECT 1 FROM logs ... LIMIT 100001)` 上限截断，或异步统计。 |
| 🟠-12 | `server.ts:120-122` vs `server.ts:217` | **env 密码可用性披露不一致**：`init-status` 已不再泄露（✅），但登录失败响应仍返回 `env_password_available: true`。登录失败本来就是攻击者可控路径，等于持续广播后门是否启用。建议始终返回 `false`，只在日志中记录。 |
| 🟠-13 | `server.ts:406-417` | **通知模板不被继承**：`mergeNotifySecrets` 只处理 5 个密钥字段，`template.body` 若前端传空串会被**直接清空**。用户保存一次设置，辛苦写的自定义模板就丢了。建议把 `template` 也纳入继承逻辑。 |
| 🟠-14 | `server.ts:854-866` | **账号批次异常处理粒度粗**：`Promise.allSettled` 失败只记 `batch[j].accessKeyId`（未脱敏，会把完整 AK 写进日志）。建议用 `masked()`。 |
| 🟠-15 | `store.ts:439-457` | **`recordActionEvent` 是 check-then-act**（先 SELECT 再 INSERT）：虽有唯一键冲突兜底（正确），但高并发下多了 1 次读。可改为直接 `INSERT ... ON CONFLICT DO NOTHING`，用 `meta.changes` 判胜负，**省掉每次读**。 |
| 🟠-16 | `engine.ts:479-511` | **`flushOutbox` 同步阻塞监控周期**：若 Telegram/webhook 网络抖动，单轮返回时间被拉长，触发方（GitHub Actions / cron-job.org）可能超时重试 → 重复执行。建议给每个通道加 `AbortSignal.timeout(8000)`。 |
| 🟠-17 | `server.ts:808-823` | **断档检查每轮跑 6 次探键**：288 轮/天 = 1728 次 D1 读，且大部分周期其实没触发过（被防抖跳过）。建议只在"本轮真正执行"且"当前小时"时才检查（复用已有的 `recordActionEvent` 小时键）。 |
| 🟠-18 | `aliyun.ts:90,133,139,147` | **异常类型断言 `as any`**：错误对象靠手动挂 `retryable` 属性传递，类型不安全且易漏（如网络错误路径没设 `retryable`）。建议定义 `class AliyunError extends Error { retryable: boolean }`。 |

### 🟡 建议（可读性 / 工程化）

| 编号 | 位置 | 建议 |
|---|---|---|
| 🟡-1 | `store/schema.ts:121-132` 与 `store.ts:35-57` | 默认值在 `DEFAULT_SETTINGS` 与 `DEFAULT_CONFIG` 两处定义，容易漂移（如 `enable_status_change_notify` 就只在 `DEFAULT_CONFIG` 有）。建议单一数据源：建表时从 `DEFAULT_CONFIG` 派生。 |
| 🟡-2 | `schema.ts:57-70` | `jobs` 表已零引用，可作一次迁移 `DROP TABLE jobs`（保留兼容则至少在注释里标 DEPRECATED）。 |
| 🟡-3 | `store.ts:399-406` | `cleanupExpiredLogs` 恒返回 0（注释说明是 D1 `meta.changes` 不可靠的妥协），调用方拿不到真实删除量。建议改用 `listLogs` 侧的裁剪或只记日志。 |
| 🟡-4 | `server.ts:405` | `INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)` 未写 `updated_at`，覆盖后 `updated_at` 不刷新。若将来有 TTL/cache 逻辑会误判。建议补上。 |
| 🟡-5 | 全局 | 未设置任何安全响应头（`CSP`/`X-Content-Type-Options`/`Referrer-Policy`/`HSTS`）。SPA 已 100% `esc()` 转义，风险低，但加几行成本近乎 0。 |
| 🟡-6 | `test/` | 引擎与数据层 0 覆盖。建议至少为 `processAccount` 的**纯策略部分**（阈值/补偿/保活判定）抽出可注入 D1 的接口并补 10 个用例。 |
| 🟡-7 | `server.ts:422` | 保活开启时"禁止手动关机"是合理的业务约束，但用户无感知。建议在前端按钮上直接禁用 + tooltip 说明。 |
| 🟡-8 | `server.ts:487-491` | `clearLogs` 支持全量删除，无二次确认与限流。建议前端加确认弹窗 + 后端加 `allowRate`。 |

---

## 六、性能与免费额度专项

### 6.1 免费额度水位（默认 5 账号 / 5 分钟一轮）

| 额度项 | 免费上限 | 本项目预估用量 | 水位 |
|---|---|---|---|
| Worker 请求数/天 | 100,000 | ~1,500（288 轮 cron + 首屏/API） | **1.5%** |
| Worker CPU/天 | 50M ms | — | 见下 |
| **Worker CPU/请求** | **10 ms** | 一轮 /__cron 峰值可能 50-200 ms | ⚠️ **主要风险** |
| D1 读/天 | 100,000 | ~3,000 | 3% |
| D1 写/天 | 50,000 | ~5,000 | 10% |
| D1 存储 | 5 GB | 日志 30 天 ≈ 5 MB | 0.1% |
| Cron Trigger | 5 个/账号 | 0（默认关闭） | 0 |

**结论：D1 与请求数都很安全，唯一需要盯的是「单请求 CPU」。**

### 6.2 单请求 CPU 热点排序（按开销）

| 排名 | 热点 | 每轮次数 | 优化后 |
|---|---|---|---|
| 1 | `Intl.DateTimeFormat` 构造 | 20-30 → **已缓存** ✅ | - |
| 2 | AES `importKey`（getConfig 解密 N 个账号） | ~10 | 缓存 `CryptoKey` → ~0 |
| 3 | HMAC `importKey`（阿里云签名） | ~10 | 缓存 `CryptoKey` → ~0 |
| 4 | `getConfig` 全表 settings 扫描 | 1 | 可加 TTL 内存缓存 |
| 5 | PBKDF2 60k（仅登录） | 1 次/登录 | 降迭代或换方案 |
| 6 | 日志页 `new Intl` × 50 | 每页 | 复用 formatter 缓存 |
| 7 | 无谓 D1 往返（断档 6 探键、recordActionEvent 先读后写） | ~16 | 小时级 + UPSERT 改写 |

**实施 🟠-7 + 🟠-6 两项即可把一轮监控的 CPU 降到原先的一半以下，且都是 10 行以内的改动。**

### 6.3 若你还有其他 Worker（账号级共享额度）

Cloudflare 免费额度是**账号级汇总**的。把上表 1.5%/3%/10% 的水位与你的其他 Worker 相加即可。由于本项目水位极低（<10%），除非其他项目是重流量站点，否则总水位仍在安全区。建议每月在 Dashboard 看一次 Workers → Usage，重点看 **CPU time** 一栏。

---

## 七、优化路线图

| 优先级 | 项 | 工作量 | 收益 |
|---|---|---|---|
| **P0** | 🔴-1 refresh 限流、🔴-3 env 密码回写、🔴-4 不修改入参 | 各 10-20 行 | 消除可被滥用的风险 |
| **P0** | 🔴-2 API Key 二选一（建议方案 A 补齐） | 0.5 天 | 功能一致性 |
| **P1** | 🟠-7 CryptoKey 缓存 + 🟠-6 复用 formatter 缓存 | 各 ~15 行 | **CPU 减半** |
| **P1** | 🟠-8 heartbeat 改周期级汇总 | ~20 行 | 日志量降 75% |
| **P1** | 🟠-5 PBKDF2 迭代下调 + 实测耗时 | ~5 行 | 登录不再撞 CPU 上限 |
| **P1** | 🟠-10 日志接口不调 getConfig、🟠-17 断档检查节流 | ~15 行 | 省 D1 读 |
| **P2** | 🟠-9 账号级保活打通或移除 | 0.5 天 | 功能一致性 |
| **P2** | 🟠-13 模板继承、🟠-12 披露收敛、🟠-16 通道超时 | 各 ~10 行 | 健壮性 |
| **P2** | 🟡-5 安全响应头、🟡-4 updated_at、🟡-8 清空确认 | 各 ~10 行 | 工程化 |
| **P3** | 🟡-1~4 数据一致性清理、🟡-6 引擎层测试 | 1-2 天 | 可维护性 |

**不建议现在做的事情**（避免过度设计）：
- 拆微服务、引入 Redis（Worker 无常驻内存意义）、加消息队列（outbox 已够用）、上 ORM（SQL 本来就少且已参数化）、给 `logs` 加 Redis 缓存（量级不值得）。

---

## 八、写得好的地方（保留）

1. **纯函数与 IO 分离**：`time.ts` / `triggers.ts` / `aliyun.sign` 零依赖 → 44 个单测零 mocking 覆盖核心逻辑。这是本项目最强的工程资产。
2. **幂等设计严谨**：`action_events` 键的时间维度设计（含跨午夜日期回退）考虑到了真实 cron 延迟场景，这是踩过坑才写得出来的代码。
3. **防抖/抢占用单语句原子操作**：`tryAcquireMonitorSlot` 用条件 UPSERT 替代读-改-写，注释里写清了"为什么"。
4. **省钱意识贯穿始终**：ETag 304、账单缓存、轻量防抖前置、heartbeat 降频、清理门控——这些都不是被要求的，是主动做的。
5. **安全修复有根因注释**：`init-status` 不泄露 `envPasswordSet`、`clientIP` 优先 `CF-Connecting-IP`，都写了"为什么"。
6. **前端转义纪律**：20 处 `innerHTML` 拼接**全部**经过 `esc()`，无一处裸拼用户数据。

---

## 九、交付自检

- [x] 已读架构模式 / 评审清单 / 性能工程 / 安全加固四份参考
- [x] 基于真实代码（11 个 TS 文件 + 2,783 行 HTML + schema），非凭记忆
- [x] 每条问题都有「位置 + 问题 + 影响 + 建议」
- [x] 性能优化有量化（热点排序 + 水位表），非拍脑袋
- [x] 安全覆盖 OWASP 关键项（注入/认证/敏感数据/访问控制/安全配置/XSS/组件/日志）
- [x] 显式假设：以「5 账号 / 5 分钟一轮 / 默认配置」为基准，账号数或间隔变化按比例伸缩
- [x] 明确"现在不要做什么"，避免过度设计
- [x] 结论可执行：P0 三项合计约 1 小时

---

## 十、整改实施记录（对应第五章问题清单）

> 基线：`dfa1dd2` → P0 波 `37eb483` / P1 波 `b2a157d` / P2 波见下。每波均通过 `tsc --noEmit` 与 `npm test`。

### P0 阻塞级（已修）

| 编号 | 处理 |
|---|---|
| 🔴-1 | `refresh` 增加按账号的分钟级节流键 `refresh:{id}:{YYYYMMDDHHmm}`，命中返回 429 |
| 🔴-2 | 补齐 API Key 能力：`GET/POST /api/v1/system/api-keys` + `DELETE .../:id`；服务端只存 SHA-256 哈希，明文仅创建时返回一次；`authenticate` 命中后按 isolate 内存 60s 节流刷新 `last_used_at`；新增「密钥」页与管理 UI（新建/吊销/有效期/权限勾选）。同时移除未被引用的 `cron:run` scope，避免再造一个死权限 |
| 🔴-3 | `ADMIN_PASSWORD` 长度 <10 直接拒绝登录（400 + 明确提示），成功登录后一律强制回写 D1，彻底消除"新旧双密码" |
| 🔴-4 | 补偿关机分支不再写 `account.instanceStatus`，改为只更新局部变量 `status` |

### P1 重要项（已修）

| 编号 | 处理 |
|---|---|
| 🟠-5 | PBKDF2 迭代 60000 → 12000（老哈希串带 `i=` 段仍按其记录值校验，可平滑迁移） |
| 🟠-6 | 新增 `time.formatWallClock()` 导出并复用 formatter 缓存，日志页不再每页 new 50 次 `Intl.DateTimeFormat` |
| 🟠-7 | `security.ts` 按主密钥字节缓存 AES `CryptoKey`；`aliyun.ts` 按 AK Secret 缓存 HMAC `CryptoKey`（上限 64 条）。一轮监控约减少 20 次 importKey |
| 🟠-8 | heartbeat 改为周期级汇总：账号级只在「有动作 / 状态变化」时写，周期末在 `runMonitorCycle` 写一条汇总（含刷新数与状态变化数），日志量约 1440 → 480 条/天 |
| 🟠-9 | `accounts.keep_alive` 接入判定（全局 AND 账号级）；`saveAccount` 未指定时默认 true；账号编辑弹窗新增「实例保活」开关 |
| 🟠-10 | 日志接口改用 `store.getSetting(env,'timezone')` 单行查询，不再为取一个字段做全量 `getConfig` + 解密所有 AK/SK |
| 🟠-11 | `listLogs` 的 COUNT 改为 `SELECT COUNT(*) FROM (SELECT 1 FROM logs ... LIMIT 100000)` 上限截断 |
| 🟠-12 | 登录失败响应恒定返回 `env_password_available: false` |
| 🟠-13 | `mergeNotifySecrets` 增加 `template.body` 继承；前端同时禁止空模板保存，语义明确 |
| 🟠-14 | 账号批次失败日志改用 `masked()`，不再把完整 AccessKeyId 写进日志 |
| 🟠-15 | `recordActionEvent` 改为 `INSERT OR IGNORE` + `meta.changes` 判胜负，省掉每次一次 SELECT |
| 🟠-16 | 通知各通道（Telegram / Webhook / Server酱 / PushPlus）加 `AbortSignal.timeout(8000)`，网络抖动不再拖长监控周期 |
| 🟠-17 | 断档检查加整点/半点门控，省掉 288 轮里绝大多数空转请求的约 7 次 D1 读 |
| 🟠-18 | 引入 `class AliyunError extends Error { retryable }`；网络错误路径补 `retryable=true`；重试判定改为 `instanceof` |

### P2 工程化（已修）

| 编号 | 处理 |
|---|---|
| 🟡-1 | `DEFAULT_CONFIG` 导出为唯一默认源，`schema.ts` 的 settings 默认值全部从它派生，消除两处漂移 |
| 🟡-2 | 迁移中增加 `DROP TABLE IF EXISTS jobs`，回收零引用表 |
| 🟡-3 | `cleanupExpiredLogs` 返回真实删除量（`meta.changes`） |
| 🟡-4 | settings 写入补 `updated_at=datetime('now')`，覆盖写时同步刷新 |
| 🟡-5 | 响应统一出口 `withSecurityHeaders()`：nosniff / Referrer-Policy / X-Frame-Options / Permissions-Policy / CSP（仅 HTML）/ HSTS（仅 https） |
| 🟡-6 | 新增 `test/audit-fix.test.ts`（7 例）：`formatWallClock` 格式与非法时区兜底、`AliyunError` 语义、PBKDF2 迭代数与校验、损坏哈希降级。测试总数 44 → 51 |
| 🟡-7 | 状态页「关机」按钮在保活开启时禁用并给出原因 tooltip（前后端判定一致） |
| 🟡-8 | `clearLogs` 增加 IP 级 60 秒限流（前端原有二次确认保留） |

### 未采纳项（附理由）

- **crypto AAD**：改动涉及所有已加密数据，迁移风险 > 收益，保持 `enc:v1:` 前缀格式不变。
- **getConfig 全量缓存**：会引入配置读取陈旧问题；当前 CPU 热点已由 CryptoKey/formatter 缓存解决。
