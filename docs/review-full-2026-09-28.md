# cdt-worker 全库代码审查报告

> 审查范围：全库（6591 行 TypeScript + 4550 行前端单文件 SPA）
> 基准 commit：`8e8e645`（第四轮审查整改后，main 与 origin/main 同步）
> 审查人：码审官 · 审查时间：2026-09-28
> 审查维度：正确性 → 安全 → 性能/额度 → 可维护性

---

## 一、审查范围与方法

| 模块 | 文件 | 状态 |
|---|---|---|
| Worker 入口 | `src/index.ts` | ✅ 已审（无问题） |
| HTTP 路由与鉴权 | `src/http/server.ts`（1610 行） | ✅ 已审（含前几轮复核） |
| 监控引擎 | `src/engine/engine.ts`（627 行） | ✅ 已审 |
| 调度与时间 | `src/engine/time.ts`、`triggers.ts` | ✅ 已审 |
| 存储与 SQL | `src/store/store.ts`、`schema.ts` | ✅ 已审 |
| 阿里云 ECS | `src/provider/aliyun.ts`（366 行） | ✅ 已审 |
| 通知通道 | `src/notify/service.ts`、`smtp.ts` | ✅ 已审 |
| 加密与鉴权 | `src/security/security.ts` | ✅ 已审 |
| DDNS 模块 | `src/ddns/*` | ✅ 已审（前几轮已深度覆盖） |
| 自建驱动 | `src/engine/selfhost.ts` | ✅ 已审 |
| **前端 SPA** | **`src/web/index.html`（4550 行）** | ⚠️ **本轮未覆盖**（见 §6） |

方法：逐文件静态审查 + 跨文件调用链追踪；每条结论均定位到具体行，无法运行时验证的项标注「需验证」。

---

## 二、结论速览

| 级别 | 数量 | 说明 |
|---|---|---|
| 🔴 **P0 阻断** | **1** | SMTP 凭据明文发送 |
| 🟠 **P1 应改** | **12** | 含 1 个本轮回归、4 个额度类、3 个健壮性 |
| 🟡 **P2 建议** | **10** | 可维护性与加固项 |

**总体判断**：**不建议在未处理 P0 的情况下继续使用非 465 端口的 SMTP**。其余 P1 不阻断发布，但 P1-7 是 `8e8e645` 引入的回归，建议立即修。

---

## 三、🔴 P0（阻断）

### P0-1　非 465 端口时，SMTP 用户名与授权码以明文发送

**位置**：`src/notify/smtp.ts:88-102`（配合 `:32-40`、`:69-72`）

```ts
const socket = connect(
  { hostname: cfg.host, port },
  { secureTransport: port === 465 ? 'on' : 'starttls', allowHalfOpen: false },   // :90
);
const greet = await conn.reply();                    // ← 明文阶段已开始
await conn.cmd('EHLO cdt-monitor');
const authPrompt = await conn.cmd('AUTH LOGIN');
const userPrompt = await conn.cmd(b64(cfg.username));   // :99  base64，可逆
const authed = await conn.cmd(b64(cfg.password));       // :101 授权码
```

**为什么**：Cloudflare `connect()` 的 `secureTransport: 'starttls'` 语义是「**先建明文连接，调用 `socket.startTls()` 后才升级**」。我全库 grep 确认：

```
sockets.d.ts:9   startTls(options?): Socket;     ← 只有类型声明
smtp.ts:90       secureTransport: ... 'starttls' ← 唯一使用点
```

**`startTls()` 在全项目从未被调用**。因此只要端口 ≠ 465，`EHLO` 与 `AUTH LOGIN` 全程跑在明文 TCP 上，base64 编码的授权码可被链路中间人直接还原——**授权码等于邮箱的完整发信权限**。

触发条件真实存在：前端端口输入框允许填任意值，用户填 **587**（最常见的 SMTP 端口）即命中；`cfg.port || 465` 只在留空时兜底。

**最小改法**（推荐方案 A，三行）：

```ts
// 方案 A：只保留隐式 TLS，其他端口直接拒绝（当前实现未升级 STARTTLS）
if (port !== 465) {
  throw new Error('SMTP 仅支持 465 隐式 TLS；587 会明文发送凭据，已拒绝连接');
}
const socket = connect({ hostname: cfg.host, port }, { secureTransport: 'on', allowHalfOpen: false });

// 方案 B（完整支持 587）：greeting → EHLO → 发 "STARTTLS\r\n" → 等 220 → socket.startTls()
// 注意：startTls() 返回新 Socket，必须重建 reader/writer，原流失效
```

**处置建议**：
1. 代码侧先按方案 A 收紧（或完整实现 STARTTLS）
2. **若该系统曾配置过 465 以外的端口并真实发过信，该邮箱授权码应视为已泄露，立即到邮箱服务商重置**
3. 顺带检查 SMTP 服务器登录日志中的异常来源 IP

---

## 四、🟠 P1（应改）

### P1-1　定时开机与定时关机可能在同一轮内同时执行

**位置**：`src/engine/engine.ts:136-151`

```ts
if (account.scheduleEnabled) {
  if (dueWithin(local, account.startTime, SCHEDULE_WINDOW_MS)) {      // :137
    const changed = await executeScheduledAction(env, config, account, 'start', now);
    ...
  }
  if (dueWithin(local, account.stopTime, SCHEDULE_WINDOW_MS)) {       // :144 独立 if，非 else-if
    const changed = await executeScheduledAction(env, config, account, 'stop', now);
    ...
  }
}
```

**为什么**：两个 `if` 完全独立，而 `SCHEDULE_WINDOW_MS = 2 * 60 * 60 * 1000`（`engine.ts:20`，**窗口宽达 2 小时**）。写入路径 `store.saveAccount` / `updateAccountConfig` **没有任何「start 与 stop 间隔必须大于窗口」的校验**。当 `|start − stop| ≤ 2h`（含误配成 08:00 / 09:00）时：

- 同一轮内先 start 再 stop → **实例被反复启停**
- 两次动作各自 `updateRuntime` + `addLog`（+ 可选 `addOutbox`）→ **+4~6 subrequest**
- 触发阿里云 `Throttling.User`，污染同账号其他操作
- 幂等键带 `action`，两个键都算新键，**幂等拦不住**

**最小改法**（一处互斥 + 一处校验）：

```ts
let scheduleActed = false;
if (dueWithin(local, account.startTime, SCHEDULE_WINDOW_MS)) {
  scheduleActed = await executeScheduledAction(env, config, account, 'start', now);
  if (scheduleActed) actions.push('scheduled_start');
}
if (!scheduleActed && dueWithin(local, account.stopTime, SCHEDULE_WINDOW_MS)) {
  scheduleActed = await executeScheduledAction(env, config, account, 'stop', now);
  if (scheduleActed) actions.push('scheduled_stop');
}
statusChangedBySchedule = scheduleActed;
```

```ts
// saveConfig / saveAccount 补校验：start 与 stop 间隔必须 > 120 分钟
```

---

### P1-2　阿里云 fetch 是全项目唯一没有超时的出站请求

**位置**：`src/provider/aliyun.ts:150-154`

```ts
resp = await fetch(`https://${host}/`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body,
});          // ← 没有 signal
```

**为什么**：对照组——通知层 `AbortSignal.timeout(8000)`、DDNS 层 `15000`、自建驱动 `60000`。唯独阿里云调用裸奔。一次「连得上但不回包」就能把整个监控周期挂住。

**最小改法**：

```ts
resp = await fetch(`https://${host}/`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  signal: AbortSignal.timeout(10000),
});
```

超时抛出的 abort 会被现有 `catch` 包成 `AliyunError(..., true)`（`aliyun.ts:155-158`），直接复用已有重试，无需改其他代码。

---

### P1-3　重试 × 分页可能放大 subrequest，且退避无抖动

**位置**：`src/provider/aliyun.ts:107-122`（重试）、`:334-364`（分页）

```ts
export async function callAliyun(..., retries = 3): Promise<...> {
  for (let attempt = 0; attempt < retries; attempt++) {
    await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 300 + attempt * 100));  // 无抖动
```

**为什么**：`getInstanceBill` 最多 3 页 × 每页 3 次尝试 = 9 subrequest；`engine.ts:369-372` 在实例级账单为空时**再调一次账号级**，最坏 2 × 9 = 18。单账号另加 `getTraffic` + `getInstanceStatus` + `getAccountBalance` 各 3 次 ≈ 12。

更糟的是**重试同步**：退避固定 `300/700ms` 无抖动，而 `Throttling.User` 被判为可重试——恰恰是「多账号同时打」才会限流，于是所有账号在同一毫秒集体重试，形成典型的重试风暴。监控主流程**没有**像 DDNS 那样的全局 subrequest 预算护栏。

> **需验证**：5 账号最坏估算约 150 subrequest 远超 50 上限，但这是「所有调用同时全量重试」的极端场景，日常不必然发生。建议先在 `wrangler dev` 打点实测一轮的真实峰值，再决定 `retries` 降到多少。

**最小改法**（按性价比）：
1. 退避加抖动：`Math.pow(2, attempt) * 300 + Math.random() * 300`
2. `retries` 默认 3 → 2
3. `getInstanceBill` 分页上限 3 → 1（单月单实例 300 条已足够）
4. 中期：`runMonitorCycle` 引入与 DDNS 同款的全局预算计数器

---

### P1-4　SMTP 无超时，且异常路径不关闭 socket

**位置**：`src/notify/smtp.ts:32-40`（readMore）、`:82-122`（sendSmtpMail）、`:69-72`（close）

```ts
private async readMore(): Promise<boolean> {
  const { done, value } = await this.reader.read();   // 无超时，服务端不回包即永久挂起
```

```ts
async close(): Promise<void> {
  try { await this.writer.close(); } catch {}
  try { this.reader.releaseLock(); } catch {}
  // ← 从未调用 socket.close()
}
```

**为什么**：
- 服务层给通知设了 8s 预算，但 SMTP 这条路径**根本不受该约束**——8s 只覆盖 HTTP 类通道，SMTP 可无限挂起
- `sendSmtpMail` 无 `try/finally`，`AUTH` / `MAIL FROM` / `DATA` 任一失败都不会 `close()`
- Free 计划「同时打开的连接数」上限 6，泄漏的 socket 会持续占额，并可能挤掉并发的阿里云 fetch

**最小改法**：

```ts
export async function sendSmtpMail(cfg, subject, html) {
  const socket = connect(...);
  const conn = new SmtpConn(socket as unknown as Socket);
  try {
    // readMore 内改为：await Promise.race([this.reader.read(), timeoutReject(SMTP_STEP_TIMEOUT_MS)])
    ...
  } finally {
    try { await conn.close(); } catch {}
    try { await socket.close(); } catch {}
  }
}
```

---

### P1-5　Spaceship 整组覆盖写没有前置护栏，可能清空域名全部解析

**位置**：`src/ddns/providers/spaceship.ts:60-64`、`:87-110`

```ts
async function fetchAll(zone, headers): Promise<any[]> {
  const data = await requestJson(...);
  const list = data?.items || data?.records || [];
  return Array.isArray(list) ? list : [];     // 形状不符 / 空体 → 静默返回 []
}
...
const list = await fetchAll(target.zone, headers);
if (idx >= 0) { ... } else { list.push({ name, type: 'A', address: ip, ttl }); }
await requestJson(url, { method: 'PUT', headers, body: JSON.stringify({ items: list }) });
```

**为什么**：该接口是「用传入数组**整体替换**域名全部记录」。一旦 `fetchAll` 因响应格式变化（例如厂商改成带 `nextToken` 的分页结构）或返回空体而得到 `[]`，这里就会 PUT 一条 A 记录，**不可逆地删掉该域名的 MX / TXT / CNAME**。触发概率不高，但后果是最严重的一类（域名邮件与验证全断）。

**最小改法**（PUT 前加完整性断言，宁可报错也不写）：

```ts
const raw = await requestJson(...);                 // 保留原始响应，不要吞掉计数
const total = Number(raw?.total ?? raw?.count ?? -1);
if (total >= 0 && (raw?.items?.length ?? 0) < total) {
  throw new DnsProviderError('spaceship', '记录分页不完整，拒绝整组写回以免误删其他记录');
}
if (!raw || (!Array.isArray(raw.items) && !Array.isArray(raw.records))) {
  throw new DnsProviderError('spaceship', '记录接口返回格式异常，拒绝整组写回');
}
```

---

### P1-6　webhook.url / webhook.headers 明文落库

**位置**：`src/store/store.ts:13-19`

```ts
const NOTIFY_SECRET_PATHS: [string, string][] = [
  ['telegram', 'token'],
  ['webhook', 'secret'],     // ← 只有 secret
  ['serverchan', 'sendKey'],
  ['pushplus', 'token'],
  ['smtp', 'password'],
];
```

**为什么**：`webhook.url` 与 `webhook.headers` 恰恰是最容易携带凭据的两个字段——钉钉/飞书/企业微信机器人的 `access_token=xxx` 就写在 URL 里，`headers` 常被填成 `{"Authorization":"Bearer xxx"}`。这两个字段明文进 D1，与 AK/SK「同等对待」的设计目标不符；D1 备份泄露时等于交出机器人发信权限。

**最小改法**（解密侧自动透传）：

```ts
const NOTIFY_SECRET_PATHS: [string, string][] = [
  ['telegram', 'token'], ['webhook', 'secret'],
  ['webhook', 'url'], ['webhook', 'headers'],   // ← 新增
  ['serverchan', 'sendKey'], ['pushplus', 'token'], ['smtp', 'password'],
];
```

> **需验证**：`getConfig` 目前只把 `secret` 置空，新增后 URL/headers 会以密文形式出现在配置响应里，建议同步加 `urlConfigured` / `headersConfigured` 标志位并确认前端回显正常。若库里已存过带 token 的机器人 URL，**建议轮换该机器人 token**。

---

### P1-7　⚠️ 本轮回归：迁移失败过一次后，`schemaReady` 永远为 false

**位置**：`src/store/schema.ts:270`（由 `8e8e645` 的 P2-R4-2 修复引入）

```ts
schemaReady = migrateFailures === 0 || migrateFailures >= MIGRATE_MAX_ATTEMPTS;
```

**为什么**：`migrateFailures` **只在失败时递增，成功时不变**。推演一个真实序列：

| 请求 | 迁移结果 | migrateFailures | schemaReady |
|---|---|---|---|
| 1 | 失败 | 1 | false（重试）✅ 符合设计 |
| 2 | **成功** | **仍为 1** | `1===0` false ‖ `1>=3` false → **false** ❌ |
| 3 | 成功 | 1 | **false** ❌ |
| … | 成功 | 1 | **false** ❌ 永久 |

也就是说：**只要某个 isolate 失败过一次，即使后续迁移完全成功，`ensureSchema` 也会在每一个后续请求上重跑全流程**（29 条建表 batch + 4 条 DDL + 迁移 SELECT + 默认值 batch，约 5~7 个 subrequest，且都是写）。这是我在上一轮修复时引入的——用「计数器是否为 0」间接推导成功，语义太脆弱。

**最小改法**（显式布尔替代计数器推导）：

```ts
let migrationOk = false;
...
try {
  await migrateInlineCredentials(env);
  migrationOk = true;              // 显式置位
} catch (e) {
  migrateFailures++;
  ...
}
...
schemaReady = migrationOk || migrateFailures >= MIGRATE_MAX_ATTEMPTS;
```

---

### P1-8　账单块每账号每轮无条件读一次缓存

**位置**：`src/engine/engine.ts:346-355`

```ts
if (config.enableBilling) {
  const BILL_TTL_HOURS = (10 + (account.id % 7)) / 60;
  const snap = await store.billingSnapshot<...>(env, account.id, { balance: '', instance_bill: cycle }, BILL_TTL_HOURS);
```

**为什么**：这段的唯一产物是「判断缓存是否命中 → 未命中才刷新」，而**本轮 `processAccount` 自己不用它的返回值**（真正给通知用的走懒加载的 `peekBillingText()`）。命中缓存的那些轮次，这个查询唯一作用是把「不查」变成一个 D1 往返。5 账号 × 288 轮/天 ≈ **1440 个/天的纯读开销**。

> 定级说明：这不必然撞 50 上限（典型周期 23~25，且账单 miss 有 `id % 7` 抖动摊平），故定 P1 而非 P0。

**最小改法**（小时级门控，与 `peekBillingText` 的懒加载思路一致）：

```ts
if (config.enableBilling && await store.recordActionEvent(
      env, `bill:${account.id}:${localFields.year}${mm}${dd}${hh}`,
      account.id, 'billing', 'refresh', '')) {
  ...原块...
}
```

1440/天 → ~120/天。另外建议把这里读到的 `snap` 回填给 `billingText`，避免同轮内 `peekBillingText()` 再读一次。

---

### P1-9　`summary()` 的账单查询是 N+1

**位置**：`src/engine/engine.ts:552`（在 `for (const account of config.accounts)` 循环内）

**为什么**：`summary()` 被 `/api/v1/status` 与 `/api/v1/widget/summary` 调用，前端轮询刷新 → N 账号 = N 个 subrequest/次刷新。5 账号时每次刷新 ≈ 7 个，其中 5 个是账单。

**最小改法**：一次性取回所有账号（D1 的 `IN` 只算 1 个 subrequest）：

```ts
// 新增 store.billingSnapshotMany(env, ids, cycleFor, ttl)
// → WHERE account_id IN (?,?,...) AND kind IN (?,?)
const snaps = await store.billingSnapshotMany(env, config.accounts.map(a => a.id), { balance: '', instance_bill: cycle }, 8760);
```

N → 1（每次刷新 7 → 3）。

---

### P1-10　遗留凭据迁移是逐条 N+1 写

**位置**：`src/store/schema.ts:219-228`

```ts
for (const r of rows) {
  const ins = await env.DB.prepare('INSERT INTO ddns_credentials ...').bind(...).run();
  const cid = Number(ins.meta?.last_row_id ?? 0);
  if (cid > 0) {
    await env.DB.prepare('UPDATE ddns_records SET credential_id=? WHERE id=?').bind(cid, r.id).run();
  }
}
```

**为什么**：每条记录 2 次独立 `run()`。若某库有 50 条遗留记录 → 冷启动 **+100 subrequest**，直接撞上限并 1102。当前大概率 0 行（一次性迁移），但「历史脏数据首次部署」是真实场景。

**最小改法**（2N → 2）：

```ts
await env.DB.batch(rows.map(r => env.DB.prepare('INSERT INTO ddns_credentials ...').bind(...)));
await env.DB.prepare(`UPDATE ddns_records SET credential_id =
  (SELECT c.id FROM ddns_credentials c
   WHERE c.credential_enc = ddns_records.credential_enc AND c.provider = ddns_records.provider)
  WHERE credential_id = 0 AND credential_enc <> ''`).run();
```

---

### P1-11　`markOutboxRetry` 先读后写，且「放弃」语义与注释不符

**位置**：`src/store/store.ts:789-803`

```ts
const row = await env.DB.prepare('SELECT updated_at FROM notification_outbox WHERE id = ?').bind(id).first();
const age = Math.floor(Date.now() / 1000) - updatedAt;
```

**为什么**：每次失败重试多 1 个 SELECT（`flushOutbox` 每次最多 10 行 → 最坏 +10/周期）。更关键的是 `updated_at` **在每次重试时都被刷成 `unixepoch()`**，所以 `age` 实际衡量的是「距上次重试」而非注释所说的「距首次入队」——只要重试间隔（300s）小于 `giveUpSeconds`（24h），记录**永远不会被放弃**。

**最小改法**：用 SQL 直接判定并更新，省掉 SELECT；`age` 改为基于入队时间（可新增 `created_at` 列或复用 `available_at` 初值）。

---

### P1-12　`webhook.secret` 是「死密钥」

**位置**：`src/notify/service.ts:23`（声明）、`src/store/store.ts:15`（加密存储）、`service.ts:76-109`（`sendWebhook` 从未使用它）

**为什么**：既没有做 HMAC 签名，也没放进请求头。用户以为配了签名密钥，实际请求是未签名的——**误导性配置**。

**最小改法**：二选一 —— 实现签名（`X-Signature: HMAC-SHA256(secret, body)`），或从配置与 UI 中移除该字段。

---

## 五、🟡 P2（建议）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| P2-1 | `engine.ts:299/321/504/578/583` | `config.keepAlive && account.keepAlive !== false` 这个判定**写了 5 遍**，其中 `summary` 里 `keepAliveBlocked` 与 `keepAliveOn` 是完全相同的表达式 | 抽 `isKeepAliveOn(config, account)`，5 处共用 |
| P2-2 | `engine.ts:300` vs `:257/283` | `keepAliveWindowOk` 用**未兜底**的 `startTime/stopTime`，而其他三处都有 `\|\| '08:00'` / `\|\| '23:00'` 兜底 → 只填了一个时间的账号保活被永久静默跳过 | 抽 `scheduleWindow(account)` 统一兜底 |
| P2-3 | `store.ts:682` | `billingCache()` 在 src 下已无调用方（全部改用 `billingSnapshot`），只剩测试桩做负向断言 | 删除或标注 `@deprecated 仅供测试` |
| P2-4 | `store.ts:693-698` / `:746-750` / `server.ts:595` | 「D1 UTC 字符串解析 + TTL 判定」**逐字重复三遍** | 抽 `parseD1Utc()` + `withinTtl()` |
| P2-5 | `server.ts:893-896` | 500 响应直接回显原始异常文本，且**未落日志** | 改成固定文案 + `addLog` 记完整信息 |
| P2-6 | `time.ts:120-122` | `stopWindowOver` 只是 `windowOver` 的别名，src 下零调用 → 死代码 | 删除 |
| P2-7 | `aliyun.ts:59-76` | HMAC 缓存以**明文 SK 字符串**作为 Map key；`clear()` 的 64 阈值会抖动式清空全部缓存 | key 改用 SHA-256；换成简单 LRU |
| P2-8 | `aliyun.ts:40-44` | ECS 侧 `percentEncode` 的两个 `replace` 是**空操作**（`encodeURIComponent` 本就不产生 `%2A/%7E`），与 DNS 侧实现漂移，含 `*!()'` 的参数会签名失败 | 复用 `ddns/providers/types.ts` 的实现，删掉本地副本 |
| P2-9 | `schema.ts:185-198` vs `store.ts:86-108` | `DEFAULT_SETTINGS` 靠注释与 `DEFAULT_CONFIG` 同步，无编译期约束 | 用类型级映射，漏写即编译报错 |
| P2-10 | `store.ts:578-586` | `COUNT_CAP = 10000` 的全表 COUNT，日志页 10s 自动刷新会吃 D1 行读配额 | 降到 2000 或首页 COUNT + 翻页复用 |

---

## 六、本轮未覆盖与需验证项

### ⚠️ 未覆盖：前端 `src/web/index.html`（4550 行）

本轮对前端单文件 SPA 的审查**未能完成**（审查介入流程未走完）。该模块尚未做过 XSS 转义覆盖、鉴权态处理、轮询开销、前后端校验一致性方面的系统检查。**建议单独安排一轮前端专项审查**，重点：

- 所有 `innerHTML` / `insertAdjacentHTML` 拼接处的转义覆盖
- 转义函数是否完整（& < > " '）及是否被误用在属性上下文
- 轮询间隔与请求数（前端请求同样消耗 Worker 请求额度）
- 表单校验与后端是否一致

### 需运行时验证的点（未做猜测）

| # | 事项 | 如何验证 |
|---|---|---|
| V1 | 阈值告警在「状态查询失败 + 同轮定时动作」叠加时是否重复发送 | 构造 `status=Stopping` + mock 查询抛错 + 超阈值，跑两轮看 `addOutbox` 次数 |
| V2 | D1 UPSERT 的 `meta.changes` 在当前版本是否可靠（`store.ts:171-180` 兜底 SELECT） | `wrangler dev` 打日志确认；若可靠可整段删除省 subrequest |
| V3 | `dueWithin` 的单测与生产时区是否同源（`test/time-window.test.ts:9` 用本地时区构造，生产为 UTC） | 确认 CI 的 `TZ` 环境变量 |
| V4 | `account.updatedAt` 是否残留早期「无时区」脏值 | 查库确认旧数据格式 |

---

## 七、安全要点汇总

**做得好的（值得保持）**

- 四类敏感数据（AK/SK、通知凭据、CRON_SECRET、DDNS 凭据）统一走 AES-GCM-256
- 常量时间比较 `constantTimeEqual` 先做 SHA-256 归一化，登录/CSRF/CRON_SECRET 全覆盖
- Cookie 属性正确：`HttpOnly; Secure; SameSite=Strict`，CSRF cookie 故意非 HttpOnly 以支持双提交
- **未发现**真正的 SQL 注入：所有外部可控值均走 `bind()`，`ORDER BY / LIMIT / IN` 占位符由数组长度生成
- **未发现**密钥进入日志或前端响应：`getConfig` 与 `ddnsOverview` 均只回 `xxxConfigured` / `masked`
- **未发现**签名 nonce 重放风险：随机 nonce + 时间戳窗口约束
- 会话 token 与 API Key 均存 SHA-256，库泄露不能直接冒用

**需要处理的**

1. **P0-1 SMTP 明文**（最高优先，可能需轮换授权码）
2. P1-6 webhook URL/headers 明文（库里若有机器人 token 建议轮换）
3. P1-12 webhook.secret 死密钥（误导性配置）
4. P2-5 500 响应回显异常原文（当前未造成泄露，但是唯一一条异常直达前端的通道）

---

## 八、总结论

**可以上线，但有前提**：

1. 🔴 **P0-1 必须先处理**。最低成本方案是限制 SMTP 只用 465 端口（方案 A，三行改动）；若业务必须用 587，则需完整实现 STARTTLS 升级。**若曾以非 465 端口真实发过信，必须轮换邮箱授权码。**
2. 🟠 **P1-7 建议立即修** —— 它是 `8e8e645` 我自己引入的回归，会让「迁移失败过一次的 isolate」在后续每个请求上重跑建表流程，属确定性浪费。
3. 其余 P1（P1-1 ~ P1-6、P1-8 ~ P1-12）不阻断发布，建议按 P1-1 → P1-5 → P1-2/3/4 → 其余的顺序排期。
4. 前端模块本轮未覆盖，**不要据此认为前端无问题**。

**性价比最高的一项**：P1-8（账单块加小时级门控）—— 单独一项就能把日均 1440 个无用 D1 读降到约 120 个。

---

> 本内容由 AI 生成，请核实后使用。
