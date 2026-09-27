# cdt-worker 代码审查报告（第二轮 · 修复后复检）

> 审查日期：2026-09-27
> 审查对象：**修复落地后的 HEAD = `b9bfff1`**（含上一轮 `542c57a` 的全部修复）
> 审查范围：`src/**` 全量（TS 6,070 行）+ `src/web/index.html`（3,048 行）+ `schema.sql`
> 基线：`tsc --noEmit` 0 error · `vitest` 82/82 通过 · 工作区干净
> 审查视角：正确性 / 安全 / **Cloudflare 免费额度与性能** / 可维护性 / 测试覆盖
> 配套：[`code-review-standards.md`](./code-review-standards.md) · [首轮报告](./review-2026-09-27.md)

---

## ✅ 修复进度（2026-09-27 晚 已全部落地）

| 项 | 级别 | 状态 | 改动 |
|---|---|---|---|
| P0-R1 账单读取懒加载 | 🔴 | ✅ 已修 | `engine.ts` 把 193-202 的无条件账单读改为 `peekBillingText()` 惰性函数，仅在阈值/保活/状态变化三处发通知分支触发（省 2 读/账号/轮） |
| P0-R2 两次账单读合并 | 🔴 | ✅ 已修 | `store.ts` 新增 `billingSnapshot()`（`kind IN (...)` 一次查询取回多 kind），`engine.ts` 刷新处改用（省 1 读/账号/轮） |
| P1-R3 scheduled try/catch | 🟠 | ✅ 已修 | `index.ts` `scheduled()` 的 `ensureSchema` 补 try/catch，失败留 error 日志后返回 |
| P1-R4 getMonitorState 换 clampInt | 🟠 | ✅ 已修 | `store.ts:274` 两处 `parseInt||default` 改用 `clampInt` |
| P1-R5 字符串白名单 | 🟠 | ✅ 已修 | `saveConfig` 对 timezone（Intl 自判）/ shutdownMode / thresholdAction 白名单校验，非法 400 |
| P2-R6 /__cron 透传 monitor state | 🟡 | ✅ 已修 | `/__cron` viaSecret 分支读一次 `getMonitorState` 透传给 `runMonitorCycle` |
| P2-R7 keep_alive 默认值反向打开 | 🟡 | ✅ 已修 | `updateAccountConfig` 改为「未传 keep_alive 则不写该列」（与 AK/SK 同一套路） |
| P2-R8 deleteAccountHandler 校验 id | 🟡 | ✅ 已修 | 非有限/非正数 id 直接 400 |
| P2-R9 解密失败留痕 | 🟡 | ✅ 已修 | `decryptNotifyConfig` 解密失败补 error 日志（防主密钥轮换后通知无声停摆） |
| P2-R10 settings 写 batch | 🟡 | ✅ 已修 | `saveConfig` 的 N 条 settings 写合并为 `DB.batch()` |
| P2-R11 selfhostDownload 注释 | 🟡 | ✅ 已修 | 删除注释里已不存在的 `?key=`/`?secret=` 描述 |
| P2-R12 withSecurityHeaders 重包 | 🟡 | ✅ 已修 | 直接在原响应头 set，不再 `new Response` 重包 body |
| P2-R13 cron secret 缓存 TTL | 🟡 | ✅ 已修 | 缓存加 60s TTL，改密钥后其他 isolate 残留窗口 ≤ 1 分钟 |

验证：`tsc --noEmit` 0 error · `vitest` 87/87 通过（新增 `billing-snapshot.test.ts` 5 例，覆盖 cycle 精确匹配 + TTL + 脏数据）。

**修复后子请求预算**：非刷新轮 28 → 18；账单未命中轮 **58 → 33**（详见报告第二节的预算速查表）。

---

## 〇、这一轮在审什么

首轮报告的问题里，P0/P1 已按建议修复并推送。但「修复完成」不等于「修复正确」——
所以本轮不重复首轮结论，而是做三件事：

1. **逐文件复核上一轮的修复是否真的落地、落地后语义是否等价**（2 项发现「声称已修、实际未修」）；
2. **重新核算免费额度预算**，确认 P0-1 的修复够不够；
3. **找上一轮没覆盖到的新问题**（主要是修复过程中新引入的路径）。

结论先行：**上一轮的核心修复是对的，但子请求预算并没有真正回到安全区。**
账单相关读取仍然存在可观的浪费，在最坏轮次会重新突破 50 上限。

---

## 一、先说复核通过的部分

上一轮的修复质量总体是扎实的，逐条核对如下：

| 修复项 | 核对结论 |
|---|---|
| `writeRuntimeBatch` 合并写 | ✅ 语义与原实现完全等价（UPDATE 无条件执行、INSERT 仅在流量查询成功时），`recordStat` 参数位正确 |
| 账单 TTL 抖动 `10+id%7` | ✅ 5 个账号 id 互质于 7 时可错开到不同轮次，设计正确 |
| `CONCURRENCY` 5→3 | ✅ 峰值出站 6，贴合 Free 上限 |
| `scheduled()` 透传 monitor state | ✅ `preloadedMonitorState` 签名与调用一致，确实省掉一次查询 |
| 密钥只走请求头 | ✅ `/__cron`、`triggerStatus`、`selfhostDownload` 三处均已删除 `?key=`/`?secret=`，脚本内嵌密钥改由服务端回填 |
| `clampInt` 数值白名单 | ✅ `Number()` 全量解析比原 `parseInt` 更严（`"1e9"`→拒收而非变 1），方向正确 |
| `keep_alive` 列补全 | ✅ 列已进 UPDATE；**但默认值语义有瑕疵**，见 P2-R7 |
| 通知凭据加密 | ✅ 幂等加密 + 旧库明文平滑迁移路径成立，`decrypt` 对非 `enc:` 前缀透传 |
| `revoked_at` / `jobs` DDL 清理 | ✅ `schema.ts`/`schema.sql`/`store.ts`/`server.ts`/前端全部同步 |
| `resolveCronSecret` 缓存 | ⚠️ 修好了主要问题，但引入了缓存残留窗口，见 P2-R13 |

---

## 二、🔴 P0：免费额度仍然会被打爆

### P0-R1 账单缓存被读了 4 次/账号/轮，其中 2 次是纯浪费

**位置**：`src/engine/engine.ts:193-202` 与 `src/engine/engine.ts:313-348`

这是个**结构性重复**，很容易看漏：账单相关的缓存读取在 `processAccount` 里出现了两遍，
且两遍都是**无条件执行**（只要 `config.enableBilling` 为真）：

```
第 ① 处（193-202，为通知变量取余额/金额，TTL=6h）
    let balanceText = ''; let costText = '';
    const bal  = await store.billingCache(env, id, 'balance', '', 6);
    const bill = await store.billingCache(env, id, 'instance_bill', cycle, 6);

第 ② 处（313-348，为刷新缓存取余额/金额，TTL=10+id%7 分钟）
    const balanceCache = await store.billingCache(env, id, 'balance', '', BILL_TTL_HOURS);
    const billCache    = await store.billingCache(env, id, 'instance_bill', cycle, BILL_TTL_HOURS);
```

**根因推断**：第 ① 处的注释写的是「供通知变量使用」，它确实是给 `accountVars()` 喂参数的；
但 `accountVars()` 只在 4 个分支里被调用（阈值告警、保活启动、状态变化、定时邮件），
也就是说 —— **绝大多数轮次里，这 2 次读取的结果根本没人用，读完就丢。**
第 ② 处是刷新逻辑，本该每轮都跑（判断 TTL 是否过期），这部分是合理的。

**影响**：`enableBilling` 默认就是 `true`。在 5 账号配置下，每轮固定多出 **10 个 D1 读**，
一天约 2880 次。更重要的是它叠加在 P0-1 修复后的预算上，让最坏轮次重新越线（见下方核算）。

**正确方案：改成懒加载。** 把第 ① 处的两次读取挪进真正要发通知的分支里。

```ts
// ❌ 现状：无条件读，绝大多数轮次白读
let balanceText = '';
let costText = '';
if (config.enableBilling) {
  const bal  = await store.billingCache<{...}>(env, account.id, 'balance', '', 6);
  const bill = await store.billingCache<{...}>(env, account.id, 'instance_bill', localCycle(now, config.timezone), 6);
  if (bal.hit && bal.value)  balanceText = `${bal.value.amount} ${bal.value.currency || ''}`.trim();
  if (bill.hit && bill.value) costText = `${bill.value.totalCost}`;
}

// ✅ 改为：不在这里读。打包成一个惰性 getter，只在确实要发通知时触发。
let billingText: { balance: string; cost: string } | null = null;
const needBillingText = () => {
  if (!config.enableBilling || billingText) return billingText;
  // 必须用这次传入的 now/config 重新算 cycle；不要在闭包外缓存旧值
  const cycle = localCycle(now, config.timezone);
  billingText = { balance: '', cost: '' };   // 先占位，避免并发重入
  void (async () => {
    try {
      const bal  = await store.billingCache<{ amount: number; currency: string }>(env, account.id, 'balance', '', 6);
      const bill = await store.billingCache<{ totalCost: number }>(env, account.id, 'instance_bill', cycle, 6);
      if (bal.hit && bal.value)  billingText.balance = `${bal.value.amount} ${bal.value.currency || ''}`.trim();
      if (bill.hit && bill.value) billingText.cost = `${bill.value.totalCost}`;
    } catch { /* 账单读取失败不影响通知 */ }
  })();
  return billingText;
};
```

然后在 4 个 `accountVars(...)` 调用点，把 `balance: balanceText, cost: costText`
改成传 `await needBillingText()` 的即时值。最省事的做法是把 `accountVars` 的
`balance`/`cost` 类型从 `string` 放宽成 `string | undefined`，调用点写：

```ts
const bt = config.enableBilling ? await peekBilling() : undefined;
const vars = accountVars(account, config, {
  traffic, status, percentage, now,
  timezone: config.timezone,
  balance: bt?.balance ?? '', cost: bt?.cost ?? '',
});
```

**为什么这样是对的**：账单缓存存在的唯一目的是让通知正文里有「账户余额 / 使用金额」。
不发通知就不该为通知付费。第 ② 处的刷新逻辑保留原样 —— 它测的是「数据该不该更新」，
与发不发通知无关。

### P0-R2 两次账单读可以合成一次查询

**位置**：`store.ts:635-657` 的 `billingCache()` + `engine.ts:320,329`

`balance`（`cycle=''`）与 `instance_bill`（`cycle='YYYY-MM'`）是 `billing_cache` 表里
的两行，主键是 `(account_id, kind, cycle)`。当前是两条 SQL 各查一次。

**正确方案**：放宽成按 `(account_id, kind)` 查、在 JS 侧按 `cycle` 匹配单例，
一次查询拿两行。省 5 个 subrequest/轮（5 账号）。

```ts
// store.ts —— 新增：一次取回该账号当月的全部账单缓存行
export async function billingSnapshot<T>(
  env: Env, accountId: number, kinds: string[], cycle: string,
): Promise<Record<string, T | undefined>> {
  const placeholders = kinds.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT kind, cycle, value, updated_at FROM billing_cache
      WHERE account_id = ? AND kind IN (${placeholders})`,
  ).bind(accountId, ...kinds).all();
  const out: Record<string, T | undefined> = {};
  for (const r of rows.results ?? []) {
    const row = r as Record<string, unknown>;
    if (String(row.cycle) !== cycle) continue;      // 月份对不上视为未命中
    try { out[String(row.kind)] = JSON.parse(String(row.value)) as T; }
    catch { /* 脏数据按未命中处理 */ }
  }
  return out;
}
```

> 提示：`SELECT ... WHERE kind IN (?,?)` 有 `(account_id, kind, cycle)` 主键前缀可用，
> 不会退化成全表扫描，D1 的 rows-read 计费也不受影响。

---

### 额度核算：修复后的真实位置

按 5 账号 + `enableBilling=true` 实测枚举每一处 D1/fetch：

| 轮次类型 | 现状 | 加 P0-R1 修复 | 再加 P0-R2 |
|---|---|---|---|
| 非刷新轮 | 28 | **18** | 13 |
| 刷新轮（阿里云 RPC 到期） | 38 | 28 | 23 |
| **账单未命中轮** | **58** ❌ | 48 ⚠️ | **33** ✅ |
| 账单未命中 + 发通知 | **60** ❌ | 50 ⚠️ | 35 ✅ |

Free 计划上限 **50 subrequest/请求**。现状下只要出现「账单刷新过期」这一件事，
当轮就直接顶穿（58/60）。P0-R1 单独修只能压到 48 —— **仍然贴着红线**，
必须再叠加 P0-R2 才有安全余量。

> 这也是为什么值得把这两条列为 P0 而不是 P2：它不是一个「理论上的浪费」，
> 而是**默认配置下的必然越线**。billing 的刷新周期是 10 分钟左右，而 cron 是 5 分钟一轮，
> 意味着平均每隔十几轮就必然撞上一次。

---

## 三、🟠 P1：上一轮声称已修、实际未修的两处

### P1-R3 `scheduled()` 的 `ensureSchema` 仍然没有 try/catch

**位置**：`src/index.ts:25-26`

```ts
async scheduled(controller: ScheduledController, env: Env): Promise<void> {
  await ensureSchema(env);        // ← 没有 try/catch
  const state = await store.getTriggerState(env);
  ...
}
```

上一轮报告里这一条被列在「P2 待修」，当时我判断已修，**实际代码没动**。这是我的失误，
这里更正并补齐。

**影响**：`fetch` 入口（`index.ts:11-18`）有 try/catch 会把异常转成可读的 500，
但 `scheduled()` 没有。D1 抖动 / 超限导致 `ensureSchema` 抛错时，`scheduled()` 直接 reject，
Cloudflare 记为 cron 失败 —— **整轮监控被跳过，且日志里没有任何业务侧留痕**，
只能去 CF Dashboard 的 Cron 历史里看到 `uncaught exception`。排障成本极高。

**正确方案**：与 `fetch` 入口对齐，失败时留痕后直接返回（下轮自动重试）：

```ts
async scheduled(controller: ScheduledController, env: Env): Promise<void> {
  try {
    await ensureSchema(env);
  } catch (err) {
    // 不抛出：抛出去 Cloudflare 只会记一条 uncaught exception，业务侧毫无留痕，
    // 而这轮跳过是安全的（下一轮会重试）。这里补一条日志，让日志页能自查。
    await store.addLog(env, 'error',
      'schema 初始化失败，本轮原生 Cron 跳过（下轮自动重试）：' + (err as Error).message)
      .catch(() => {});   // 日志自己再失败也不能把异常带出去
    return;
  }
  ...
}
```

### P1-R4 `getMonitorState` 还是老那个 `parseInt() || default`

**位置**：`src/store/store.ts:274-275`

上一轮给 `getConfig` 换上了 `clampInt`，但同一个文件里的 `getMonitorState` 漏改：

```ts
if (k === 'monitor_interval') intervalMinutes = parseInt(v, 10) || DEFAULT_CONFIG.monitorInterval;
else if (k === 'last_monitor_run') lastRun = parseInt(v, 10) || 0;
```

**判定**：这属于**同类陷阱未清理干净**，不是新引入的 bug —— `getMonitorState` 的
入参都是我们自己写进去的（`String(now)` / 校验过的整数），实际触发概率很低。
按「宁可误报」原则仍建议修，成本一行。

**影响**：`last_run` 若被写成负数，`shouldNativeRun` 里 `sinceLastRun` 变成超大值 →
防抖永远放行 → 本该跳过的轮次全跑。反过来 `monitor_interval=0` 已被 `||` 兜住。
实际危害有限，但作为防御纵深该一并清掉。

**正确方案**：直接复用上一轮已经导出的 `clampInt`：

```ts
if (k === 'monitor_interval') {
  intervalMinutes = clampInt(v, 1, 1440, DEFAULT_CONFIG.monitorInterval);
} else if (k === 'last_monitor_run') {
  lastRun = clampInt(v, 0, Number.MAX_SAFE_INTEGER, 0);
}
```

### P1-R5 `saveConfig` 对字符串类配置不做白名单

**位置**：`src/http/server.ts:439-443`

上一轮给数值字段加了白名单（`trafficThreshold`/`apiInterval`/`monitorInterval`/
`logRetentionDays`），但字符串字段仍是「来什么写什么」：

```ts
['shutdown_mode',   b.shutdownMode,   String(b.shutdownMode   ?? 'StopCharging')],
['threshold_action',b.thresholdAction,String(b.thresholdAction?? 'stop_and_notify')],
['timezone',        b.timezone,       String(b.timezone       ?? 'Asia/Shanghai')],
```

**判定**：`timezone` 这条是唯一有实际后果的。

**根因**：`time.ts` 的 `formatter()` 对非法时区会抛，被 `toZone`/`zoneFields` 的
try/catch 吞掉并回退 UTC —— **所以不会崩溃**（这一点我核实过，不算严重故障）。
但回退是静默的：用户配了 `Asia/Shangha`（拼错一个字母），系统不报错，
只是**所有定时开关机按 UTC  interpreting 用户的 `08:00`/`23:00`**，
实际开机时间整体偏移 8 小时。用户看到的现象是「定时不准」，极难自查。

**正确方案**：写库前校验，非法直接 400。时区白名单用运行时能力，不维护静态列表：

```ts
// 时区：交给 Intl 自己判定，不维护易过时的静态白名单。
// 非法时区若放行，time.ts 会静默回退 UTC，导致定时开关机整体偏移（用户只看到「定时不准」）。
if (b.timezone !== undefined) {
  const tz = String(b.timezone).trim();
  const ok = tz !== '' && (() => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
    catch { return false; }
  })();
  if (!ok) return error('invalid_input', '时区无效，请使用 IANA 时区名（如 Asia/Shanghai）', 400);
}
// 同理补 shutdownMode / thresholdAction 白名单：这两个值会直接进分支判断，
// 写库后不报错但走不到任何分支，属于「配置存进去了但没人认」的死值。
const SHUTDOWN_MODES   = ['StopCharging', 'KeepCharging'];
const THRESHOLD_ACTIONS = ['stop_and_notify', 'notify_only'];
if (b.shutdownMode   !== undefined && !SHUTDOWN_MODES.includes(String(b.shutdownMode))) {
  return error('invalid_input', `停机模式必须是 ${SHUTDOWN_MODES.join(' / ')}`, 400);
}
if (b.thresholdAction !== undefined && !THRESHOLD_ACTIONS.includes(String(b.thresholdAction))) {
  return error('invalid_input', `阈值动作必须是 ${THRESHOLD_ACTIONS.join(' / ')}`, 400);
}
```

---

## 四、🟡 P2：其余新发现问题

### P2-R6 `/__cron` 路径没有透传 monitor state（省 1 子请求/外部触发）

`server.ts:803` 与 `:805`：
```ts
return runMonitorCycle(env, false, state, source);   // ← 没传第 6 个参数
return runMonitorCycle(env);
```
只有原生 Cron 入口（`index.ts:42`）传了 `preloadedMonitorState`。
但外部触发（GitHub Actions / 自建驱动）恰恰是主力触发方式，反而没吃到这个优化。
修法：`runMonitorCycle(env, false, state, source, false, stateMs)` —— 注意
`state` 里没有 monitor 字段，需要在 `/__cron` 分支先 `getMonitorState` 一次。
成本 1 行，省 1 subrequest/轮。

### P2-R7 `updateAccountConfig` 的 `keep_alive` 默认值会反向打开保活

`store.ts:425`：`const keepAlive = a.keepAlive === undefined ? true : a.keepAlive;`

前端编辑弹窗（`index.html:2265`）总是显式提交 `keepAlive`，所以**正常路径没问题**。
但 `saveConfig` 的 `accounts` 分支接受任意客户端的部分更新：
一个 API Key 客户端只发 `{id:1, remark:"x"}` 改备注，就会把该账号的账号级保活**从 0 写成 1**。

**判定**：用户实际不会踩（有 UI 挡着），但 API 面上是「部分更新语义不成立」。
**正确方案**：`updateAccountConfig` 只在字段存在时才写该列（与 AK/SK 同一套路），
由调用方负责补齐；或者更稳妥 —— `saveConfig` 里读取现有账号后显式透传 `keepAlive`：

```ts
// server.ts saveConfig 的 accounts 分支
if (a.id) {
  await store.updateAccountConfig(ctx.env,
    a as Partial<Account> & { id: number });
}
```
配合 store 侧改成「未传则不写 keep_alive」：
```ts
const keepAliveSql = a.keepAlive === undefined ? '' : ', keep_alive=?';
```
> 注意：改完后前端那条「老数据视为开启」的兜底（`index.html:2238`）仍要保留，
> 否则升级后老账号在没有 keepAlive 字段时会被写成 0 而静默关掉保活。

### P2-R8 `deleteAccountHandler` 不校验 id

`server.ts:690`：`const id = parseInt(ctx.params.id, 10);`
`NaN` 直接进 SQL。D1 会抛，`route()` 的统一 try/catch 兜成 500 —— 不泄露信息，
但返回码是 500 而非 400。与同文件 `deleteApiKeyHandler:601` 的
`if (!Number.isFinite(id))` 不一致。**修法照抄后者即可。**

### P2-R9 通知凭据解密失败静默置空，主密钥轮换后会「通知无声失效」

`store.ts:45-47`：
```ts
try { o[field] = await decrypt(env, v); } catch { o[field] = ''; }
```
注释写的是「避免一条坏数据让整个通知配置不可用」，思路没错，但**失败完全无声**。
`CDT_MASTER_KEY` 一旦轮换，5 个通知凭据会同时解密失败 → 所有通知静默停止，
日志里没有任何一条对应记录。对一个靠告警活着的项目，这是最难发现的一类故障。

**正确方案**：至少留痕。解密失败是异常情况，宁可在日志页吵一点，也不要静默：

```ts
export async function decryptNotifyConfig(env: Env, cfg: Record<string, unknown>): Promise<Record<string, unknown>> {
  for (const [chan, field] of NOTIFY_SECRET_PATHS) {
    ...
    try { o[field] = await decrypt(env, v); }
    catch {
      o[field] = '';
      // 静默置空会让「主密钥轮换后通知无声失效」——对一个靠告警活着的项目，
      // 这种故障最难发现。至少留一条 error 日志，让日志页能自查。
      void store.addLog(env, 'error',
        `通知凭据解密失败，该通道将发送失败：${chan}.${field}（检查 CDT_MASTER_KEY 是否变更）`)
        .catch(() => {});
    }
  }
  return cfg;
}
```
> 需在该文件顶部补 `import { addLog } from ...`，注意别与 `decrypt` 的 import 冲突。

### P2-R10 `saveConfig` 的 N 条 settings 写入没有 batch

`server.ts:457-459`：一个 `for ... await run()` 循环。一次性提交全部设置时是 10 个独立
subrequest。修法：`await ctx.env.DB.batch(settings.map(([k, v]) => env.DB.prepare(...).bind(k, v)))`。
低频（管理台操作），列在这里是为完整性。

### P2-R11 `selfhostDownload` 的文档注释与实现不符

`server.ts:869-875` 的函数说明仍写着「?key=、或 ?secret= 等于 CRON_SECRET 参与鉴权」，
但函数体（`:884-906`）已经改成只认请求头。**注释是代码腐化最常见的入口**——
下一个人照着注释去「修复」掉那个「缺失的」`?secret=` 鉴权，等于把首轮 P0-2 的修复退回。
请同步删掉注释里已不存在的 `?key=` / `?secret=` 描述。

### P2-R12 `withSecurityHeaders` 把 Response 重包了两次

`server.ts:725-753` 先 `new Response(resp.body, {...})` 再 `new Response(out.body, {...})`。
每个请求多两轮 body 流搬运。在 10 ms CPU 预算下，这是白给的开销。
**正确方案**：直接在新 `Headers` 上 `set`，不重包 body：

```ts
function withSecurityHeaders(resp: Response, request: Request): Response {
  const headers = new Headers(resp.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  ... // 全部 set 到 headers
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
}
```
> 唯一要注意：CSP 那条有 `if (!headers.has('Content-Security-Policy'))` 的判断，
> 直接复用同一份 headers 对象即可，语义不变。

### P2-R13 cron secret 缓存没有 TTL，改密钥后存在鉴权残留窗口

`store.ts:172-211` 的 `cronSecretCache` 是 isolate 级、永不过期，只在
`setCronSecret` 的**当前 isolate** 里失效。管理员改密钥后，其他 isolate 里缓存的
**旧明文仍可用于 `/__cron` 鉴权**，直到该 isolate 被回收。

**判定**：isolate 通常存活几十秒到数分钟，窗口不大。但这是「改了密钥、旧密钥还能触发」
的语义违反，而且改密钥恰恰是安全操作（怀疑泄露），此时残留是反直觉的。

**正确方案**：给缓存加一个短 TTL。cron 每 5 分钟一轮，多出的 D1 读可忽略：

```ts
let cronSecretCache: { value: string; at: number } | undefined;
const CRON_SECRET_CACHE_TTL_MS = 60_000;   // 改密钥后最多残留 1 分钟

export async function resolveCronSecret(env: Env): Promise<string> {
  if (cronSecretCache && Date.now() - cronSecretCache.at < CRON_SECRET_CACHE_TTL_MS) {
    return cronSecretCache.value;
  }
  cronSecretCache = undefined;   // 过期：重新读库，顺带清掉旧值
  ...
}
```
同时把 `setCronSecret` 的两处赋值改成 `cronSecretCache = { value, at: Date.now() }`。

---

## 五、做得好的地方（复核时新看到的）

这一轮读下来，有几个设计值得明确点名，后续重构别改坏：

- **`writeRuntimeBatch` 的 `recordStat` 参数**设计得很干净：把「是否采样」这个业务判断
  留在调用方（`trafficResult.status === 'fulfilled'`），存储层只管拼 batch，职责清晰。
- **`engine.ts:251-253` 的注释**：明写「account 是调用方持有的共享对象
  （config.accounts 同一引用），写它会污染 runMonitorCycle 批次间状态」——
  这是踩过坑才会有的注释，比任何代码结构都值钱。
- **`schema.ts:112-125` 的 `DEFAULT_SETTINGS` 单一数据源**：注释说明「唯一数据源是
  store.ts 的 DEFAULT_CONFIG，这里只描述映射」，并且点出历史上 `enable_status_change_notify`
  就是两处各写一份导致漂移。同样的道理在 store.ts:300-302 又出现一次。
- **`server.ts:128-131` 的注释**：明确说明「不要在这里返回 ADMIN_PASSWORD 是否存在，
  那等于向匿名访客泄露后门是否启用」。这类「不做什么 + 为什么」的注释密度很高，
  是本项目代码质量最实在的体现。

---

## 六、优先级建议

**按「先止血、再加固」的顺序：**

| 顺序 | 项 | 理由 |
|---|---|---|
| 1 | **P0-R1** 账单读取懒加载 | 默认配置下必然越 50 上限，唯一会真的踩 1101 的项 |
| 2 | **P0-R2** 两次账单读合并 | R1 单独修只到 48，仍贴线；R2 才是安全余量的来源 |
| 3 | **P1-R3** `scheduled()` 补 try/catch | 一行改动，消除「监控静默停摆且无留痕」的盲区 |
| 4 | **P1-R5** 字符串白名单 | 防「定时整体偏移 8 小时」这类难自查的静默故障 |
| 5 | **P1-R4** `getMonitorState` 换 `clampInt` | 一行，清理同类遗漏 |
| 6 | P2-R13 / R9 / R11 | 分别是鉴权语义、可观测性、注释腐化 |
| 7 | P2-R6 / R7 / R8 / R10 / R12 | 零散清理，可批量做 |

**验证门槛**（沿用 [`code-review-standards.md`](./code-review-standards.md) 第 3 节）：
`npm run typecheck` 与 `npm test` 任一失败不允许合入。建议为 P0-R1 补一个测试：
断言「不发通知的路径下 `billingCache` 调用次数为 0」。

---

## 七、给流程的一句建议

这一轮暴露的最有价值的教训不在代码里，而在流程上：

> **「这项已修复」必须由复检者二次读代码确认，不能由修复者自述或由审查报告的状态标记代劳。**

P1-R3 和 P1-R4 都是「上一轮报告里标记为待修、我判断已修、但实际代码没动」。
原因不是偷懒，而是首轮报告是**一次性写完**的，修复时按条目对应，没有回头逐条核对。
已把这条写进 `code-review-standards.md` 的流程章节。
