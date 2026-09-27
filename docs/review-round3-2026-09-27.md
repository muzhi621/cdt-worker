# cdt-worker 代码审查报告（第三轮 · 修复落地后复检）

> 审查日期：2026-09-27
> 审查对象：**修复落地后的 HEAD = `2330788`**（含首轮 `542c57a` + 二轮 `9bdf1bd` + 保活日志 `2330788`）
> 审查范围：`src/**` 全量（TS 3,895 行）+ `src/web/index.html` + 10 个测试文件
> 基线：`tsc --noEmit` 0 error · `vitest` 87/87 通过 · 工作区干净
> 审查视角：正确性 / 安全 / **Cloudflare 免费额度与性能** / 可维护性 / 测试覆盖
> 配套：[审查标准](./code-review-standards.md) · [首轮](./review-2026-09-27.md) · [第二轮](./review-round2-2026-09-27.md)

---

## ✅ 修复进度（截至 2026-09-27）

| 项 | 级别 | 状态 | 本轮复核方式 |
|---|---|---|---|
| P0-R1 账单读取懒加载 | 🔴 | ✅ 已修 | grep `peekBillingText` 三处调用点，确认惰性语义成立 |
| P0-R2 两次账单读合并 | 🔴 | ⚠️ **只落地一半** | 见下方 🔴 T1 |
| P1-R3 `scheduled()` try/catch | 🟠 | ✅ 已修 | 逐行读 `index.ts:24-33`，catch 内 `addLog` + `return` 正确 |
| P1-R4 `getMonitorState` 换 `clampInt` | 🟠 | ✅ 已修 | `store.ts:288-289` 已用 `clampInt` |
| P1-R5 字符串白名单 | 🟠 | ✅ 已修 | `server.ts:447-449` 白名单生效 |
| P2-R6 ~ R13（8 项） | 🟡 | ✅ 已修 | 逐条 grep 核对，无残留 |
| 保活日志分类 | — | ✅ 已修 | `engine.ts:304` + 前端 tab |

**结论先行：P0-R2 的「两次账单读合并」只做了刷新处，通知路径（发通知的轮次）仍是两次独立查询。**
这意味着二轮报告里「再叠加 P0-R2 后 = 33 ✅」的安全余量**没有真正兑现**——凡是发通知的轮次，
每账号仍多付 1 个 subrequest。这是本轮最重要的发现，也是唯一会重新逼近 50 上限的一条。

---

## 〇、这一轮在审什么

三轮下来，前两轮的修复都已推送。本轮按 `code-review-standards.md` 的阶段 3.5 强制要求做三件事：

1. **逐条复核前两轮声称已修的项**，确认代码真的动了、语义等价；
2. **找修复过程中新引入或修复不完整的路径**；
3. **重新核算免费额度预算**，确认是否真的回到安全区。

**复核结论：前两轮的修复质量是扎实的，P0-R1（懒加载）方向完全正确。**
但 P0-R2（合并查询）在落地时被拆成了两半——刷新处用了新函数，通知路径没跟上。

---

## 一、先说复核通过的部分

| 修复项 | 核对结论 |
|---|---|
| `peekBillingText` 惰性化 | ✅ 闭包 + `billingRead` 标志位正确，三处 `accountVars` 调用点（阈值/保活/状态变化）均改为 `await peekBillingText()`，同轮内复用一次 |
| `billingSnapshot` 实质正确 | ✅ `cycleFor` 按 kind 分别传 cycle（balance `''` / instance_bill `YYYY-MM`），`cycle` 精确匹配、UTC 解析 `updated_at`、脏数据按未命中——五个单测覆盖了这些边界 |
| `scheduled()` 的 try/catch | ✅ 与 `fetch` 入口对齐，catch 内 `addLog(...).catch(() => {})` 双重兜底，不会把日志自身的失败带出去 |
| `keep_alive` 判定链 | ⚠️ `updateAccountConfig` 已改为「未传则不写列」，但 **`control()` 的判定条件仍未同步**，见 🟠 T1 |
| 三接口限流 | ✅ `control` / `notify/test` / `deleteAccount` 均有 `allowRate` |
| 日志 COUNT / 断档检查位置 | ✅ `COUNT_CAP` 10000、断档检查仍在防抖之后（这一处**尚未挪到槽位抢占后**，但已有注释说明是刻意为之，属可接受取舍） |

---

## 二、🔴 P0-T1 `peekBillingText` 没用上 `billingSnapshot`（P0-R2 只落地一半）

**位置**：`src/engine/engine.ts:197-208`

`billingSnapshot()` 已于二轮实现并接入刷新处（`engine.ts:326`），但**通知路径的 `peekBillingText`
仍然是两次独立的 `store.billingCache()` 调用**：

```ts
// engine.ts:196-208 —— 现状
let billingText: { balance: string; cost: string } | null = null;
async function peekBillingText(): Promise<{ balance: string; cost: string }> {
  if (!config.enableBilling) return { balance: '', cost: '' };
  if (billingText) return billingText;
  billingText = { balance: '', cost: '' };
  try {
    // ↓ 第 1 次 D1 读
    const bal  = await store.billingCache<{ amount: number; currency: string }>(env, account.id, 'balance', '', 6);
    if (bal.hit && bal.value) billingText.balance = ...;
    // ↓ 第 2 次 D1 读
    const bill = await store.billingCache<{ totalCost: number }>(env, account.id, 'instance_bill', localCycle(now, config.timezone), 6);
    if (bill.hit && bill.value) billingText.cost = ...;
  } catch { /* 账单读取失败不影响通知 */ }
  return billingText;
}
```

而同一个文件里，账单**刷新**处已经用的是合并版：

```ts
// engine.ts:326-328 —— 已合并
const snap = await store.billingSnapshot<...>(
  env, account.id, { balance: '', instance_bill: cycle }, BILL_TTL_HOURS,
);
```

### 影响

`peekBillingText` 只在三个分支被调用，但**这三个分支恰好就是会发通知的轮次**：

| 调用点 | 行号 | 场景 | 频率 |
|---|---|---|---|
| 阈值告警 | `engine.ts:231` | 流量超阈值 | 中 |
| 保活启动 | `engine.ts:308` | 实例意外停止 | 中 |
| **状态变化通知** | `engine.ts:381` | Running/Stopped 翻转 | **最高** |

也就是说：**每次真正发通知的轮次，每个账号仍然多付 1 个 subrequest**（2 → 1 的缺口）。
5 账号同轮发通知 = 每轮 +5。按二轮报告的账目，「账单未命中 + 发通知」这一档
从估算的 35 实际回到 **40**，距 50 上限只剩 10 的余量。

这是一条**确定性浪费**：只要发通知就必然发生，与缓存命中与否无关。

### 正确方案

`peekBillingText` 直接复用现成的 `billingSnapshot` 即可，无需新代码：

```ts
async function peekBillingText(): Promise<{ balance: string; cost: string }> {
  if (!config.enableBilling) return { balance: '', cost: '' };
  if (billingText) return billingText;
  billingText = { balance: '', cost: '' };
  try {
    const snap = await store.billingSnapshot<{ amount?: number; currency?: string; totalCost?: number }>(
      env, account.id, { balance: '', instance_bill: localCycle(now, config.timezone) }, 6,
    );
    if (snap.balance?.hit && snap.balance.value) {
      billingText.balance = `${snap.balance.value.amount} ${snap.balance.value.currency || ''}`.trim();
    }
    if (snap.instance_bill?.hit && snap.instance_bill.value) {
      billingText.cost = `${snap.instance_bill.value.totalCost}`;
    }
  } catch { /* 账单读取失败不影响通知 */ }
  return billingText;
}
```

> 改动量约 10 行，无新增依赖。**修完「账单未命中 + 发通知」档位应从 40 回到 35。**

### 为什么这条值得单独成 P0

二轮报告里把 R2 列为「R1 单独修只到 48 仍贴线，必须叠加 R2 才有安全余量」。
现在的情况是：R1 修了，R2 **修了一半**。刷新路径的安全余量是真的，通知路径的不是。
而通知恰恰是本项目存在的理由——**发不出通知的监控等于没有监控**。

---

## 三、🔴 P0-T2 `summary()` 同样是两次独立查询

**位置**：`src/engine/engine.ts:517-527`

同一个文件的 `summary()`（状态页数据源）里，账单读取也还是拆开的两条：

```ts
if (config.enableBilling) {
  try {
    const bal  = await store.billingCache<...>(env, account.id, 'balance', '', 8760);   // 1 次
    ...
    const bill = await store.billingCache<...>(env, account.id, 'instance_bill', cycle, 8760); // 2 次
    ...
  } catch { }
}
```

与 T1 同因同源。差别在于：

- `summary()` 走 `/api/v1/status`，**前端状态页每次刷新都调用**，且刷新是用户高频行为；
- 这里的 TTL 传 `8760`（1 年）表示「取缓存即可」，从不刷新——所以每次都实打实付 2 次读；
- 5 账号 × 每次状态页刷新 = 多 5 个 subrequest。

**修法与 T1 完全一致**，同样切到 `billingSnapshot`（TTL 传大值即可，语义不变）。

> T1 与 T2 本质是**同一处遗漏的两个实例**，建议一起改，改完补一个测试断言
> 「`summary()` 单次调用只产生 1 次 billing 查询」。

---

## 四、🟠 P1-T1 `control()` 的保活判定没看账号级（真 bug）

**位置**：`src/engine/engine.ts:475` 对比 `src/engine/engine.ts:545`

同一份代码里，两个地方对「这个账号能不能手动关机」给出了**不同的答案**：

```ts
// engine.ts:475 —— control() 的判定
if (config.keepAlive && action === 'stop') throw new Error('manual shutdown is disabled while keep-alive is enabled');

// engine.ts:545 —— summary() 对外暴露的 keepAliveBlocked
keepAliveBlocked: config.keepAlive && account.keepAlive !== false,
```

### 复现路径

1. 管理员开启**全局保活**（默认 `keepAlive = true`）；
2. 在「账号 → 配置」里把**某个账号的账号级保活关掉**（`accounts.keep_alive = 0`；
   这条链路二轮 P2-R7 已经修好，能正常写入）；
3. 状态页拿到 `keepAliveBlocked = true && (0 !== false) = **false**`；
4. 前端据此**解除关机按钮的 disabled**（`index.html:2033`）；
5. 用户点「关机」→ `control()` 命中 `config.keepAlive === true` → **抛异常**：
   `manual shutdown is disabled while keep-alive is enabled`。

### 为什么这是 bug 而不是设计

- **前后端语义不一致**：前端依据的是 `keepAliveBlocked`（含账号级），后端依据的是
  `config.keepAlive`（只有全局）。同一个操作，一个说可以，一个说不行。
- **错误信息误导**：用户明明已经关掉这个账号的保活了，被告知「保活已开启，不允许手动关机」。
- **属于第二轮刚修好的同一条链路**：P1-4（keep_alive 死字段）、P2-R7（默认值语义）两轮都在修
  「账号级保活」，但 `control()` 这处判定从头到尾没同步过。**修复不完整**，与前两轮
  P1-R3/P1-R4 是同一类问题——改了一处忘了另一处。

### 正确方案

把判定收敛成同一个纯函数，避免同类分歧再次发生：

```ts
// engine.ts —— 新增单一真源
function keepAliveBlocksManualStop(account: Account, config: store.Config): boolean {
  return config.keepAlive && account.keepAlive !== false;
}
```

然后 `control()` 与 `summary()` 都调用它：

```ts
// control()（:475）
if (keepAliveBlocksManualStop(account, config) && action === 'stop') {
  throw new Error('该账号已开启实例保活，不允许手动关机（可在「账号 → 配置」关闭该账号的保活）');
}

// summary()（:545）
keepAliveBlocked: keepAliveBlocksManualStop(account, config),
```

顺带把错误信息改成指向正确位置——现在的文案里说「可在账号配置里关闭账号级保活」，
但按钮正是因为关闭了它才解禁的，用户会被这句提示带偏。

---

## 五、🟡 P2 清单

### P2-T2 `getConfig` 里 `enableScheduleMail` 缺 `map.has()` 兜底

**位置**：`src/store/store.ts:331`

```ts
cfg.enableScheduleMail = map.get('enable_schedule_mail') === '1';   // ← 没有 has() 兜底
```

同一函数里其余布尔字段全是「有键才覆盖、无键回退 `DEFAULT_CONFIG`」的写法：
`keep_alive`(:329)、`enable_billing`(:330)、`enable_status_change_notify`(:332)。

**判定：当前无实际影响**，因为 `DEFAULT_CONFIG.enableScheduleMail = false`，
缺失键时 `undefined === '1'` 恰好也得到 `false`，与默认值相同。

但请注意 `store.ts:314-316` 的注释原文：

> 兜底值统一与 `DEFAULT_CONFIG` 一致……此前写死 `'95'/'KeepCharging'/false/false`
> 与 `DEFAULT_CONFIG`(90/StopCharging/true/true) 冲突，在 ensureSchema 默认键写入失败
> 或旧库缺键时会静默回退到错误默认值。

注释点名的「false/false」两个字段里，`enable_status_change_notify` 已经补了兜底，
**`enable_schedule_mail` 是同一条注释下漏掉的那一个**。一旦将来把默认值改成 `true`，
缺键时就会静默变回 `false`，且无人知晓。按「同类陷阱一次性清干净」原则，补一行即可。

### P2-T3 `controlHandler` 限流注释与实现不符

**位置**：`src/http/server.ts:544-549`

```ts
// 限流：control 会真实调用阿里云启停 API，连点等于把实例反复启停 + 打爆 RPC。
// 与 refresh 同口径按账号做分钟级节流。
...
if (!allowRate('control:' + clientIP(ctx.request), 10, 60_000)) {
```

注释说「按**账号**做分钟级节流」，实际 key 是 `'control:' + clientIP(...)` —— **按 IP**。

**判定**：按 IP 限流本身没问题，甚至更严（同一 NAT 后的所有账号共享配额）；
多账号用户在管理台连点控制多个账号时，10 次/分钟也够用。**不构成功能缺陷**。
但注释错了，且错在"这是按账号"这个会让后来者误判配额归属的点上。
改注释即可，或确认 refresh 是否也是按 IP、是否要与它对齐。

### P2-T4 断档检查用 UTC 分钟，而非配置时区墙钟

**位置**：`src/http/server.ts:1130`

```ts
if (new Date().getUTCMinutes() % 30 === 0) {
```

本项目所有其余时间判断（定时开关机、保活时段、账单账期、补偿窗口）都统一走
`zoneFields()` / `toZone()` 取配置时区墙钟，唯独这里直接读 `getUTCMinutes()`。

**判定**：影响很小——`Asia/Shanghai` 下 UTC 的 `:00`/`:30` 对应北京时间的 `:08`/`:38`，
只是检查时刻偏移了 8 分钟，而断档阈值本身是 30 分钟量级，语义不受影响。
不修也能过，但它是**时区处理上的一处不一致**，将来若有人按"半点"语义去推理时序会踩坑。
若要修：`zoneFields(new Date(), config.timezone).minute` 判断是否落在 `0` 或 `30` 附近。

---

## 六、做得好的地方（复核时新看到的）

- **`billingSnapshot` 的 `cycleFor: Record<string, string>` 设计**（`store.ts:697`）。
  用"每个 kind 各自的 cycle"取代二轮建议的单一 `cycle` 参数，避开
  `balance=''` 与 `instance_bill='YYYY-MM'` 账期维度不同的坑。这个改动比原方案更正确。
- **`summary()` 里 TTL 传 `8760` 的语义标注**（`engine.ts:513` 注释明写
  "TTL 传大值表示取缓存即可"）。把"只读不刷"这个非显然的意图写清楚了，
  后来者不会误以为这里漏了刷新逻辑。
- **`recordActionEvent` 作为「每天一次」维护任务的门控**（`server.ts:1165-1169`）。
  用 `cleanup:{YYYYMMDD}` 幂等键把原本每轮都跑的清理压到每天一次，思路干净。
- **`deleteActionEvent` 的阈值去抖只在 `due` 时执行**（`engine.ts:211-213`）。
  注释写明"未刷新数据的周期里阈值状态不可能变化，无条件 DELETE 纯属浪费 D1 操作"——
  这是把省额度思考到了逻辑冗余层面，而不只是调用次数层面。

---

## 七、优先级建议

| 顺序 | 项 | 级别 | 理由 | 工作量 |
|---|---|---|---|---|
| 1 | **T1** `peekBillingText` 切 `billingSnapshot` | 🔴 | 发通知轮次确定性多付 1/账号，安全余量未兑现 | ~10 行 |
| 2 | **T2** `summary()` 切 `billingSnapshot` | 🔴 | 状态页每次刷新都付，与 T1 同源 | ~10 行 |
| 3 | **T1'** 补测试：断言发通知时只 1 次 billing 查询 | 🟡 | 锁住语义，防止回归（二轮报告已提过类似建议） | 小 |
| 4 | **T1-T1' 一起**后重新核算预算 | — | 确认「账单未命中 + 发通知」回到 35 | — |
| 5 | **四-T1** `control()` 收敛到同一判定函数 | 🟠 | 真 bug：前端放行、后端拒绝 | ~5 行 |
| 6 | P2-T2 `enableScheduleMail` 兜底 | 🟡 | 一行，清掉注释点名过的陷阱半成品 | 1 行 |
| 7 | P2-T3 / T4 注释与一致性 | 🟡 | 注释腐化与风格统一 | 小 |

**验证门槛**（沿用 [`code-review-standards.md`](./code-review-standards.md) 第 3 节）：
`npm run typecheck` 与 `npm test` 任一失败不允许合入。

---

## 八、这一轮的教训

三轮审查暴露的模式已经很清楚了，值得写进标准：

> **「合并/优化类」修复必须同时枚举所有调用点，不能只改最先看到的那一个。**

P0-R2 是典型：修复者锁定「engine.ts 里账单读取出现两处」，改了刷新处，
但没意识到「通知路径的读藏在一个函数内部（`peekBillingText`），从调用处看不出来」。
同类现象在 P1-T1 再现——`keep_alive` 语义修了三处（`updateAccountConfig`、
`saveAccount`、前端），`control()` 又漏一处。

这不是疏忽，是**「按位置修复」而非「按语义修复」的固有盲区**。
建议把「同一语义的判定/取值必须收敛到单一函数」加进维度 D（可维护性）作为硬要求。
