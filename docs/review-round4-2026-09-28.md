# cdt-worker 第四轮代码审查报告

> 审查标准：`docs/code-review-standards.md`（2026-09-27 初版 + 三轮复检 + 2026-09-28 第四轮增补）
> 基准 commit：`149a5a5`（fix: 代码审查报告整改 P0/P1/P2，已推送 origin/main）
> 审查人：元审（火眼眼）· 审查时间：2026-09-28

---

## 一、概览

本轮是**修复后的复核轮**，不是从零通读。重点三件事：

1. 按阶段 3.5 逐条核对第三轮报告的 8 项修复是否真落地（不看 commit message）
2. 按**新增的阶段 3.6**把修复当新代码审一遍
3. 按维度 A–F 对改动区域及周边做通审

**门槛状态（实测，非推断）**

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | ✅ `TSC_EXIT=0`，0 error |
| `npx vitest run` | ✅ `VITEST_EXIT=0`，**13 文件 / 148 用例全过** |

**总体结论**：第三轮的 P0（账单重复读）确实修好了，且修得干净——`grep` 决策锁通过、语义等价、还补了回归测试。
但**修复本身引入了 1 个新的 P0**：第三轮那个 P2 级的 DDNS 护栏，阈值算错了，而且算错的方式恰好让它保护不了自己要保护的东西。

这正是本轮把「阶段 3.6 修复的二次审查」写进标准的直接原因。

---

## 二、分级清单

### 🔴 P0-R4-1　DDNS 护栏阈值越线，且未覆盖 D1 —— 护栏保护不了它要保护的东西

**位置**：`src/ddns/sync.ts:38`（`DDNS_SUBREQUEST_BUDGET = 20`）、`:126` `:153`（判断点）；叠加点 `src/http/server.ts:1211`

**为什么**

护栏的注释写得很清楚，目的就是"避免触发 CF 1101 中断监控"。但它有两个致命问题：

1. **阈值本身就越线。** DDNS 同步跑在监控周期的**同一个 invocation** 里
   （`server.ts:1211`，`runMonitorCycle` 尾部搭便车）。监控峰值已占 ~35，
   Free 计划上限 50，**留给 DDNS 的只剩 ~15**，而护栏设成了 20。
   `35 + 20 = 55 > 50` —— 护栏在最坏情况下仍然放行到越线，等于发了一张"合法的越线许可证"。

2. **它只数 `fetch`，没数 D1。** `providerCalls` 只统计 `provider.query` / `provider.update`
   （`:144` `:162`），但同一循环里还有：
   - `store.readCredential(env, rec)`（`:136`）→ **1 次 D1 读**（每条记录一次）
   - `store.markSynced(...)`（`:148` `:164`）→ **1 次 D1 写**
   - `addDdnsLog(...)`（`:169`）→ **1 次 D1 写**

   D1 的读和写**同样计入 50 上限**。按 20 次厂商调用估算，D1 侧还要再加约 20–40，
   **实测峰值可达 ~75+**，比没有护栏时好不了太多，而 1101 一旦触发是**整轮 cron 中断**——
   监控主流程会跟着一起挂，这恰恰是护栏想避免的后果。

**建议**

- 立刻把阈值改成有推导链的值：`50 − 监控峰值(35) − 余量(5) ≈ 10`，并在常量旁把推导写进注释，
  注明"监控预算变了必须同步改这里"
- 护栏计数改成**估算 subrequest**：`readCredential` / `markSynced` / `addDdnsLog` 各计 1，
  而不是只数厂商 `fetch`
- 配合 P1-R4-2（凭据缓存），直接砍掉大部分 D1 读
- 若想根治：**把 DDNS 同步挪出监控周期**（独立 cron 槽位，当前只占 1/5 有余量），
  从架构上消除叠加 —— 这属于 owner 决策项

### 🟠 P1-R4-1　凭据存在性校验只做在“新增”，编辑路径完全没校验

**位置**：`src/http/server.ts:1431-1433`（`ddnsUpdateRecord`）对比 `:1392-1398`（`ddnsCreateRecord` 已校验）

**为什么**

第三轮 P2-3 的语义是「记录引用的凭据必须存在」，但这个语义有**两个**写入实现点：create 和 update。
上轮只覆盖了 create。现在通过编辑接口可以写入一个悬空/已删除的 `credentialId`，
同步时 `readCredential`（`ddns/store.ts:331-338`）拿到空对象 `{}` → 厂商鉴权失败。

最难受的是**故障表现**：日志里是"鉴权失败"而不是"凭据不存在"，排查方向直接被带偏。

这正是标准第 5 节反模式「修好一处同类陷阱就当全改了」、阶段 3.5 第 4 条「按语义而非按位置修复」的**原地复发**——
上一轮刚为这条吃过亏（`billingSnapshot` 只改了刷新处），这一轮在同一个报告的另一个条目上又犯了。

**建议**

- 抽 `assertCredentialExists(env, id)`，`ddnsCreateRecord` 与 `ddnsUpdateRecord` 共用
- 同步更新决策锁清单：校验类改动必须 grep 确认 create/update 两条路径都调用了

### 🟠 P1-R4-2　`readCredential` 在记录循环内重复读 + 重复解密（N+1）

**位置**：`src/ddns/sync.ts:136`（循环内逐条调用）、`src/ddns/store.ts:331-338`（实现）

**为什么**

`readCredential` 每次调用都做 **1 次 D1 读**（`getCredentialEnc`）+ **1 次 AES-GCM 解密**。
同一分组下的多条解析记录**通常共用同一个凭据**，现在每条记录各付一遍。

- 额度：N 条记录 = N 次 D1 读，与 P0-R4-1 的越线问题直接叠加
- CPU：AES-GCM 解密不是免费的，而 **CPU 10 ms 是崩溃线**，切换时刻集中解密有风险

**建议**

在 `runDdnsSync` 内加一个本地 `Map`（key 用 `credential_id` 或密文串），命中即复用。
这个 Map 是**函数内局部变量、一轮结束即回收**，不存在 isolate 长活泄漏问题，与维度 C「模块级 Map 要有上限」不冲突。

### 🟠 P1-R4-3　限流清理用“本次调用的窗口”判断所有 key，长窗口限流会被提前清零

**位置**：`src/http/server.ts:63-72`（`rateMap` / `allowRate`）

**为什么**

```ts
if (rateMap.size > 500) {
  for (const [k, v] of rateMap) {
    if (now - v.start >= windowMs) rateMap.delete(k);   // ← windowMs 是本次调用的窗口
  }
}
```

`windowMs` 取自**当前这次调用**（60s / 15min 不等），但被拿去判断**所有** key 的过期。
`login` 的窗口是 15 分钟（`:224`），可只要任一短窗口调用（如 `control:` 60s）触发了 `size > 500` 的清理，
login 的计数在 **60 秒后**就会被删掉 —— 内存层登录限流被静默削弱。

好消息是登录还有 **D1 第二道**（`recentLoginFailures`，跨 isolate 生效）兜底，所以不是完全绕过，故定 P1 而非 P0。
但第一道防线的强度是不可预期的，这本身就该修。

**建议**

entry 里存自己的 `windowMs`，清理时用 `v.windowMs` 判断：
`rateMap.set(key, { start: now, count: 1, windowMs })`，清理条件改为 `now - v.start >= v.windowMs`。

### 🟡 P2-R4-1　window 模式成员时段空缺仍被放行，“配了不生效”没堵完

**位置**：`src/http/server.ts:1370-1377`

**为什么**

```ts
if (m.windowStart && parseHm(m.windowStart) === null) { ... }
```

只校验"填了且格式非法"，**空串直接放行**。window 模式下时段为空的机器 `parseHm('')` 返回 null →
**永远不会被选中**，用户看到的是"机器在组里但从不值班"。

上轮 P2-2 的意图就是消灭这类静默失效，这里留了口子——**修了格式错误，没修语义缺失**。

**建议**

校验时带上分组的 `mode`：window 模式下 `windowStart` / `windowEnd` 必填；其他模式允许为空。
（需要 handler 先取一次 group，或直接信任前端传入的 mode 并做白名单校验）

### 🟡 P2-R4-2　迁移失败后 `schemaReady` 仍置 true，isolate 内不再重试

**位置**：`src/store/schema.ts:245-260`

**为什么**

P2-5 补的日志解决了"无从发现"，但没解决"卡住"。`schemaReady = true` 是**无条件**执行的，
一旦迁移因某条脏数据失败，该 isolate 生命周期内**永不再重试**，只有冷启动才会再试一次。
线上可能长期停在"凭据未迁移"状态，而证据只有日志里那一条 error。

**建议**

失败时不置 `schemaReady`（下次请求自然重试），但要配一个"同一 isolate 内最多重试 N 次 / 冷却窗口"，
避免每请求重试把 D1 写打满。或在日志文案里明确写"需修复脏数据后重新部署才会再迁移"。

### 🟡 P2-R4-3　DDNS 变更每条记录写一条日志，切换时刻会灌屏

**位置**：`src/ddns/sync.ts:169`

**为什么**

维度 F 可观测性明确要求"是否会刷屏"。切换时刻多组多记录同时变更，
每条都 `addDdnsLog` → 每条 1 条日志 + 1 个 D1 写，与 P0-R4-1 的额度问题叠加。

**建议**

本轮内把 details 累积起来，同步结束后写**一条**汇总日志（`server.ts:1213` 已经在做汇总了，
可以把逐条日志收敛成"仅失败逐条、成功汇总"）。既省 D1 写，日志页也更好读。

### 💭 P3-R4-1　`addDdnsLog` 用动态 import，命名容易误导

**位置**：`src/ddns/sync.ts:209-212`

顶部 `import * as store from './store'` 指向的是 **`src/ddns/store.ts`**（DDNS 自己的 store，没有 `addLog`），
所以这里用动态 import 去拿 `src/store/store.ts` 的 `addLog`。功能上没问题，但读代码的人很容易误以为两个 `store` 是同一个。

**建议**：顶部补一条 `import * as rootStore from '../store/store'`，删掉动态 import —— 静态意图更清楚，也省掉每次的动态解析。

### 💭 P3-R4-2　日期正则只校验形状，不校验真实日期

**位置**：`src/http/server.ts:1310-1311`

`RE_ANCHOR_DATE = /^\d{4}-\d{2}-\d{2}$/` 会放行 `2026-99-99`。前端已做了"2 月 31 日收敛"，
后端不必重复实现一遍；但**注释里没说明这是有意的形状校验**，后人可能误以为做过日期校验。

**建议**：保持现状，补一句注释"仅形状校验，语义由 scheduler 兜底"。

---

## 三、肯定项（这些是团队想保持的水位）

1. **P0-R2 的两个账单修复是真修好了，不是改了个样子。**
   `grep -rn "billingCache(" src/` 全仓只剩 `store.ts:682` 的定义和几处注释文字，无任何业务调用点；
   且 `billingSnapshot`（`store.ts:726-756`）对 `balance` / `instance_bill` 分别按各自 cycle 精确匹配，
   TTL 语义与原两次调用**逐一对齐**（通知路径 6h、summary 8760h），属于"行为等价的替换"，不是"改了但悄悄变了语义"。

2. **P2-6 把教训固化成了自动化。** `test/billing-query-count.test.ts` 直接断言
   "每账号只产生 1 次 billing 查询、`billingCache` 不被调用"。第三轮的教训是"藏在函数内部的调用点会漏"，
   这个测试正是针对那类漏改的永久哨兵 —— 比在报告里写一句话强得多。

3. **护栏的设计取舍是对的。** "宁可晚几分钟切换，也不拖垮监控"完全符合本项目的硬约束
   （额度优先级高于功能及时性）。阈值算错了，但**思路值得保留**，改数字即可，不用推倒。

4. **DDNS 路由鉴权零遗漏。** `server.ts:166-183` 共 18 条 DDNS 路由，`scope: 'admin'` 覆盖率 100%，
   连通测试与手动同步这类"会打外部 API"的接口也都在内。

5. **迁移补日志改得稳。** `schema.ts:250` 的 `addLog` 位置正确（logs 表在前面的 batch 建表阶段已建，
   不会因缺表失败），且带 `.catch(() => {})` 兜底，不会因为记日志这件事本身搞挂 ensureSchema。

---

## 四、上轮修复复核签字（阶段 3.5，逐条 grep 核对）

复核人：元审 · 方式：打开代码 + grep 关键标识符，**不采信 commit message 与报告状态标记**

| 上轮条目 | 核对方式 | 结论 |
|---|---|---|
| P0-1 `peekBillingText` 切 `billingSnapshot` | `engine.ts:204-205` 实际调用 + grep `billingCache(` 无残留 | ✅ 已落地 |
| P0-2 `summary()` 切 `billingSnapshot` | `engine.ts:552-553` 实际调用 | ✅ 已落地 |
| P1-1 连通测试 / 手动同步加限流 | `server.ts:1523`（ddns-test 5/60s）、`:1556`（ddns-sync 3/60s） | ✅ 已落地 |
| P2-1 分组时间格式校验 | `server.ts:1312-1319` `groupTimeError`，create(`:1326`) 与 update(`:1340`) **均调用** | ✅ 已落地 |
| P2-2 成员时段格式校验 | `server.ts:1370-1377` | ⚠️ **落地不完整** → 见 P2-R4-1（空串放行） |
| P2-3 凭据引用存在性校验 | create 有（`:1395-1398`）、update **无**（`:1431-1433`） | ⚠️ **落地不完整** → 见 P1-R4-1 |
| P2-4 DDNS 同步护栏 | `sync.ts:38,63,126,153` | ⚠️ **已落地但阈值错误** → 见 P0-R4-1 |
| P2-5 迁移失败补日志 | `schema.ts:247-251` | ✅ 已落地 |
| P2-6 回归测试 | `test/billing-query-count.test.ts`，全量 148 用例含它 | ✅ 已落地 |

**签字**：8 项中 5 项完整落地，3 项落地不完整。其中 **P2-4 的"不完整"是 P0 级**（本轮新发现 P0-R4-1），
**P2-3 的"不完整"是 P1 级**（本轮新发现 P1-R4-1）。

---

## 五、遗留与下一步

**建议本迭代内修（按优先级）**

1. P0-R4-1 — 护栏阈值改 10 并写推导链 + 计数覆盖 D1（改动小、收益最大）
2. P1-R4-1 — 抽 `assertCredentialExists`，create/update 共用
3. P1-R4-2 — 凭据本地缓存（顺带缓解 P0-R4-1）
4. P1-R4-3 — `allowRate` 按 key 自身窗口清理

**需 owner 决策**

- DDNS 同步是否从监控周期里独立出去（独立 cron 槽位）。
  代价：多占 1 个 Cron Triggers（当前 1/5）；收益：从根本上消除与监控的 subrequest 叠加。
  若分组/记录规模会继续增长，建议独立。

**观察指标（发布后 24h）**

- CF Dashboard → Workers → Metrics：是否出现 **1101**（subrequest 超限）
- 日志页：是否出现「DDNS 同步已达本轮回填上限」——出现了就说明阈值仍需下调
- D1 → Rows written：切换时刻是否异常抬升

**流程层面（已写入标准）**

- 新增**阶段 3.6「修复的二次审查」**：修复不是风险终点，修复是新代码
- 新增**审查报告模板**与**决策锁清单**，后续报告按此结构产出
- 维度 B/C 各新增 checklist，反模式表新增 3 条（阈值拍脑袋 / 护栏只数 fetch / 校验只加在新增路径）

---

## 六、修复落地（2026-09-28 23:22）

| 条目 | 修复内容 | 验证 |
|---|---|---|
| 🔴 **P0-R4-1** | `sync.ts`：`DDNS_SUBREQUEST_BUDGET` 20 → **10**，常量上方补完整推导链（50 − 35 − 5）；计数口径由「只数厂商 fetch」改为 `spent` 覆盖 **D1 读/写**（`readCredential` / `markSynced` / 汇总日志 / 未知厂商分支全部计入） | `test/ddns-budget.test.ts` 前 3 例 |
| 🟠 **P1-R4-1** | `server.ts`：抽 `assertCredentialExists()`，`ddnsCreateRecord` 与 `ddnsUpdateRecord` **共用** | 两条路径均可 grep 到（决策锁） |
| 🟠 **P1-R4-2** | `sync.ts`：新增 `credCache`（函数内局部 Map，一轮有效），同一凭据只读一次、解密一次 | 同上测试第 4 例 |
| 🟠 **P1-R4-3** | `server.ts`：`rateMap` entry 存 `windowMs`，清理与过期判定都改用**该 key 自己的窗口** | 代码复核 |
| 🟡 **P2-R4-1** | `server.ts`：`ddnsSaveMembers` 取分组 mode，window 模式下时段为空返回 400 | 代码复核 |
| 🟡 **P2-R4-2** | `schema.ts`：迁移失败**不置** `schemaReady`（下个请求重试，上限 3 次），日志写明「第 n 次 / 已达上限需重新部署」 | 代码复核 |
| 🟡 **P2-R4-3** | `sync.ts`：成功切换明细累积，循环结束后合成**一条**日志；失败仍逐条（要能定位到具体域名） | 代码复核 |
| 💭 **P3-R4-1** | `sync.ts`：函数内动态 `import()` 改为顶部 `import * as rootStore` | tsc 通过 |
| 💭 **P3-R4-2** | `server.ts`：正则上方补注释「仅形状校验，日期语义由 scheduler 兜底」 | — |

**修复过程中额外发现并一并修掉的缺口**：未知厂商分支的 `markSynced`（`sync.ts` 约 115 行）
同样是一次 D1 写，原先没计入护栏 —— 是写回归测试时才暴露出来的。

**新增回归测试** `test/ddns-budget.test.ts`（4 例），锁住三件事：
阈值 ≤ 15（剩余预算）、常量必须写明推导链（含 50 与 35 两个数字）、D1 调用必须计入护栏。

**门槛**：`tsc --noEmit` 0 error；`vitest` **14 文件 / 152 用例全过**（148 基线 + 4 新增）。
