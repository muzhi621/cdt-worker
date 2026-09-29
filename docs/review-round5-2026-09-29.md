# CDT-Monitor 第五轮代码审查报告

- **审查日期**：2026-09-29
- **审查基准**：`8e8a645`（main）+ 工作区未提交改动（上一轮全库审查的修复，14 文件 +634/−238）
- **审查范围**：全库 6591 行 TS + **首次全量覆盖前端 `src/web/index.html`（4552 行）**（上轮未覆盖、本轮补齐）
- **审查方式**：静态脚本粗筛（`analyze.sh`）+ 子代理全量通读前端 + 人工逐条复核 + 阶段 3.6「修复的二次审查」（把上一轮我自己写的修复当新代码审）
- **门槛实测**：`tsc --noEmit` 0 error；`vitest` 14 文件 / **152 用例全过**

---

## 一、结论概览

| 级别 | 数量 | 说明 |
|---|---|---|
| 🔴 Critical | 2 | 1 个会改错 DNS 指向，1 个能打满 D1 日配额 |
| 🟠 Major | 6 | 含 **1 个我自己上一轮引入的回归**（通知被直接放弃） |
| 🟡 Minor | 8 | 防御性缺口与体验问题 |
| 💭 Nit | 5 | 风格与一致性 |

**本轮最需要先修的三件事**：
1. **P0-R5-2（我自己的回归）** —— 老 outbox 记录首次发送失败就永不再试，告警直接消失
2. **P0-R5-1** —— 日期下拉静默改写「轮换基准日」，可能把解析指向错误机器
3. **P1-R5-4** —— 我新加的「定时最小间隔 120 分钟」后端校验没有配套前端提示，用户保存会莫名失败

---

## 二、🔴 Critical

### P0-R5-1　日期控件年份候选不含当前值 → 静默改写轮换基准日

**位置**：`src/web/index.html:1989-1993`（`dtOptionsHtml`）、`:4168`（排班弹窗基准日）、`:4274-4276`（差异提交）、`:4103/:4126`（分组弹窗）

**现象**：

```js
// 1989-1993：年份候选只有 [当年-3, 当年+8]
if (part === "y") {
  const y = new Date().getFullYear();
  for (let i = y - 3; i <= y + 8; i++) list.push(String(i));
}
```

```js
// 4168：把分组现有的 anchor_date 直接传给控件
dtControlHtml("sched-anchorDate", "anchorDate", g.anchor_date || todayStr(), "date")
```

后端 `parseGroupBody` 把未指定的 `anchorDate` 默认成 `1970-01-01`（`server.ts:1355`）。当一个 rotate 分组的 `anchor_date` 是 `1970-01-01`（或空串）时：

1. `1970` 不在 `2023..2034` 的候选里 → **没有任何 `<option>` 带 `selected`**
2. 浏览器按规范自动选中第一项 → 控件显示 `2023-xx-xx`
3. 用户只是想改个成员排序，顺手点了一下「月」下拉 → `bindDtPickers` 的 `build()` 把文本框写成 `2023-09-29`
4. `:4276` 的差异比较 `ad !== (g.anchor_date || "")` 判定「有改动」→ 提交 `patch.anchorDate = "2023-09-29"`

**后果**：轮换原点从 1970 被挪到 2023，**差值 53 年**，轮换相位整体错位 → **值班机器被静默换掉，DNS 解析指向错误的 IP**。用户以为自己只改了成员，界面无任何提示。

同类次生问题：`interval` 模式的 `anchorAt` 留空时，下拉默认值是「现在」，用户一碰下拉就把「留空 = 1970-01-01」改写成今天，同样改变相位。

**根因推断**：控件做了「候选区间」但没考虑「当前值可能落在区间外」这一合法情况；而 `web-forms.test.ts` 里 `openModal` 是桩，控件真实行为从未被测到，所以缺陷一直潜伏。

**修复方案**（两处一起改，缺一不可）：

```js
// ① dtOptionsHtml 末尾：当前值不在候选内就补进去（1989-2001）
function dtOptionsHtml(part, cur) {
  const list = [];
  if (part === "y") { const y = new Date().getFullYear();
    for (let i = y - 3; i <= y + 8; i++) list.push(String(i)); }
  else if (part === "mo") for (let i = 1; i <= 12; i++) list.push(pad2(i));
  else if (part === "d") for (let i = 1; i <= 31; i++) list.push(pad2(i));
  else if (part === "h") for (let i = 0; i < 24; i++) list.push(pad2(i));
  else for (let i = 0; i < 60; i++) list.push(pad2(i));
  // 当前值超出候选区间时必须补进列表：否则 <select> 静默回落第一项，
  // 用户一改月/日就把 1970-01-01 这类合法基准日改写成区间首年
  if (cur != null && cur !== "" && list.indexOf(String(cur)) < 0) list.unshift(String(cur));
  return list.map(function (v) {
    return '<option value="' + v + '"' + (v === cur ? " selected" : "") + ">" + v + "</option>";
  }).join("");
}
```

```js
// ② 4168：编辑态显式兜底，与后端默认保持一致
+ dtControlHtml("sched-anchorDate", "anchorDate", g.anchor_date || "1970-01-01", "date") + "</div>"

// ③ 4274-4276：比较基准同步用同一个兜底值
const ad0 = (g.anchor_date || "1970-01-01").trim();
if (ad && ad !== ad0) patch.anchorDate = ad;
```

> 补一条回归测试：`test/web-forms.test.ts` 目前桩掉了 `openModal`，控件行为零覆盖。建议新增一组直接调用 `dtOptionsHtml` 的用例，断言「传入 1970 时输出里有 `value="1970"` 且带 `selected`」。

---

### P0-R5-2　老 outbox 记录首次发送失败即被放弃（**本轮我自己引入的回归**）

**位置**：`src/store/schema.ts` MIGRATIONS（`ALTER TABLE notification_outbox ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0`）+ `src/store/store.ts:859-880`（`markOutboxRetry`）

**现象**：

```sql
-- 迁移只加了列，没有回填。老行 created_at = 0
ALTER TABLE notification_outbox ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0
```

```sql
-- markOutboxRetry 的放弃判定
WHERE id = ? AND (unixepoch() - COALESCE(NULLIF(created_at, 0), updated_at)) >= ?
```

`updated_at` 的建表默认值同样是 `0`（`schema.ts:74`），而 `addOutbox` 在本次改动前**从不写 `updated_at`**，它只在 `markOutboxRetry` 结束时才被赋值。于是：

- 部署前就已入队、且尚未重试过的老行：`created_at = 0` → `NULLIF` 得 NULL → `COALESCE` 退回 `updated_at = 0`
- `unixepoch() - 0 ≈ 1.7e9`，远大于放弃阈值 `24*3600`
- → **这条通知在第一次发送失败时就被直接标记为 `failed`，一次重试机会都没有**

**后果**：对一个靠告警活着的项目，这是最难发现的一类故障——部署当口的待发通知全部静默丢弃，日志里只有一条「通知发送失败已放弃」。

**根因**：用「列默认值 0」表示「未知」又当作「入队时间」参与运算，且迁移没有回填存量数据。这正是标准文档里写的「按位置修复、未枚举存量数据」的反模式。

**修复方案**（迁移里回填，一行 SQL）：

```ts
// MIGRATIONS 追加一条（紧跟 ADD COLUMN created_at 之后）
// 存量行 created_at 会被 DEFAULT 填成 0，若不回填，「放弃判定」会把它当成
// 「1970 年入队」从而立刻放弃 —— 部署当口的待发通知会被静默丢弃。
// updated_at 有值的用它的时间（保留真实年龄），都没有则视作刚入队。
`UPDATE notification_outbox SET created_at = COALESCE(NULLIF(updated_at, 0), unixepoch()) WHERE created_at = 0`,
```

**并补一条测试**（`test/` 新增），锁住这个语义：

```ts
it('存量 outbox 行（created_at=0）首次失败也要重试，不得直接放弃', async () => {
  // 造一行 created_at=0 / updated_at=0 的老数据，调用 markOutboxRetry(id, 'e', 300, 86400)
  // 断言返回 'retry' 而不是 'failed'
});
```

---

## 三、🟠 Major

### P1-R5-1　日志轮询不看页面可见性 → 单标签页可吃满 D1 日读配额

**位置**：`src/web/index.html:3711-3717`

```js
$("logs-auto").addEventListener("change", function () {
  if (this.checked && TABS.indexOf("logs") >= 0) {   // TABS 是静态数组 → 恒为 true
    stopLogTimer();
    logTimer = setInterval(loadLogs, 10000);
  } else stopLogTimer();
});
```

- `TABS` 在 `:1910` 是静态常量数组，`indexOf("logs") >= 0` **恒为 true**，这个判断是死代码，切到别的 Tab 定时器照跑
- 没有 `document.hidden` 判断，后台标签页继续轮询
- 每次 `loadLogs()` 触发后端 `listLogs`，其中有一次 `SELECT COUNT(*) FROM (SELECT 1 FROM logs ... LIMIT 2000)` 扫描

6 次/分 × 2000 行 ≈ **72 万行/小时 → 约 7 小时吃满 D1 免费 5M 行/天读配额**（实际取决于 logs 表真实行数，需运行时验证；我已经把 `COUNT_CAP` 从 10000 降到 2000，把这块降到 1/5，但前端不改仍会滚）。

**修复方案**：

```js
let currentTab = "status";                 // 新增；switchTab 里赋值
function startLogTimer() {
  stopLogTimer();
  // 页面隐藏或不在日志页时不空转：免费额度下每 10 秒一次带 COUNT 扫描的请求是纯浪费
  logTimer = setInterval(function () {
    if (document.hidden || currentTab !== "logs") return;
    loadLogs();
  }, 10000);
}
$("logs-auto").addEventListener("change", function () {
  if (this.checked) startLogTimer(); else stopLogTimer();
});
document.addEventListener("visibilitychange", function () {
  if (!document.hidden && $("logs-auto").checked) startLogTimer();
});
```

> 可选加强：轮询间隔 10s → 30s，并让自动刷新跳过 `total` 计数（翻页信息不需要每次刷新）。这两条加起来能把这块开销再降一个数量级。

---

### P1-R5-2　401/403 无统一处理 → 会话过期后写操作静默失败

**位置**：`src/web/index.html:2260-2265`（`apiJson`）

后端会话 24h 过期、改密码会吊销其它会话，但前端除「改密码」分支外**没有任何地方处理 401/403**。过期后点保存只弹一句 toast，页面仍停在控制台，用户会以为服务坏了。

**修复方案**（注意排除业务性 401：改密码时「当前密码错误」的 `error.code` 是 `invalid_credentials`）：

```js
let appReady = false;                       // enterApp() 里置 true

async function apiJson(path, opts) {
  const res = await api(path, opts);
  let data = {};
  try { data = await res.json(); } catch (e) { data = {}; }
  const code = data && data.error && data.error.code;
  if (appReady && (res.status === 401 || res.status === 403) && code !== "invalid_credentials") {
    appReady = false;
    stopLogTimer();
    csrf = "";
    showView("auth");
    showAlert(errText(data) || "登录状态已失效，请重新登录");
  }
  return { ok: res.ok, status: res.status, data };
}
```

---

### P1-R5-3　前后端校验不一致（后端缺三条，可被绕过前端直接写脏值）

**位置**：`src/http/server.ts:554`（`saveConfig` 的 accounts 循环）

| 项 | 前端 | 后端 | 后果 |
|---|---|---|---|
| `maxTraffic > 0` | `:2811`、`:2909` 有 | **无**（`store.ts:477` 直接入库） | 写 `0` → 使用率恒 0 → **阈值永不触发，超额不停机**；写负数 → 百分比为负 |
| AccessKey ID 以 `LTAI` 开头 | `:2807`、`:2926` 有 | **无** | 可写入任意字符串 |
| `regionId` 非空 | `:2796` 有 | **无** | 带着空地域去调 ECS |

`maxTraffic = 0` 那条后果最重：本项目核心功能就是「超流量停机」，写 0 等于把保护关掉且界面看不出来。

**修复方案**（`server.ts:554` 循环开头补）：

```ts
for (const a of b.accounts as Partial<Account>[]) {
  if (a.accessKeyId !== undefined && a.accessKeyId !== '' && !/^LTAI/i.test(String(a.accessKeyId))) {
    return error('invalid_input', `AccessKey ID 通常以 LTAI 开头：${String(a.accessKeyId).slice(0, 16)}`, 400);
  }
  if (a.maxTraffic !== undefined) {
    const mt = Number(a.maxTraffic);
    if (!Number.isFinite(mt) || mt <= 0 || mt > 1_000_000) {
      return error('invalid_input', `流量上限必须是 1~1000000 之间的数字：${a.maxTraffic}`, 400);
    }
  }
  if (a.regionId !== undefined && !String(a.regionId).trim()) {
    return error('invalid_input', '地域 ID 不能为空', 400);
  }
  // …原逻辑
}
```

---

### P1-R5-4　新加的「定时最小间隔」后端校验没有配套前端提示（**本轮我自己引入**）

**位置**：`src/http/server.ts:455-465`（`scheduleTooClose` / `SCHEDULE_MIN_GAP_MINUTES = 120`）、`:554-578`；前端 `:1146/:1150`、`:1837/:1841` 只有 `type="time"`

我在上一轮为修 P1-1（同轮双发）加了后端校验：start/stop 间隔 ≤120 分钟直接 400。但前端没有任何对应校验或文案——用户把开机 08:00、关机 09:00 保存，前端全绿、后端整单拒绝，**整张设置表一个字段都没保存成功**，只看到一句错误 toast。

这说明我违反了自己在标准里写下的「校验要覆盖全部写入路径 → UI 必须同源」。

**修复方案**（前端复用已有的 `hmMin`，定义在 `:4138`，函数声明会提升可直接用）：

```js
// 在 :2813（if (bad) return;）之前插入；edit 弹窗 :2904 同样处理
if (account.scheduleEnabled) {
  const gap = (function (s, e) {
    const a = hmMin(s), b = hmMin(e);
    if (a === null || b === null) return 999;
    let d = Math.abs(a - b);
    if (d > 12 * 60) d = 24 * 60 - d;   // 跨午夜取环形最短间隔
    return d;
  })(account.startTime, account.stopTime);
  if (gap < 120) {
    toast("开机与关机时间间隔需大于 120 分钟，否则会与 2 小时命中窗口重叠导致实例反复启停", "err");
    return;
  }
}
```

---

### P1-R5-5　数值范围前后端不一致（两处，保存即 400）

| 项 | 前端 | 后端 | 位置 |
|---|---|---|---|
| 日志保留天数 | `min="1" max="3650"`，提示 1–3650（`:1770`、`:3494`） | `parseClampedNum(..., 1, 365, 30)`（`server.ts:486`） | 填 400 前端放行、后端 400 |
| API 刷新间隔 | `min="10"`（`:1252`），JS 无任何校验（`:3478`） | `parseClampedNum(..., 60, 86400, 600)`（`server.ts:482`） | 填 10 前端放行、后端 400 |

**修复方案**（前端对齐后端，改动最小）：

```html
<!-- 1770 --> <input id="log-retention" ... min="1" max="365" />
<!-- 1252 --> <input id="set-interval" ... min="60" max="86400" step="5" />
```
```js
// 3495
if (!(days >= 1 && days <= 365)) { toast("保留天数需在 1–365 之间", "err"); return; }
// 3478 前补
const apiInterval = parseInt($("set-interval").value, 10) || 60;
if (!(apiInterval >= 60 && apiInterval <= 86400)) { toast("API 间隔需在 60–86400 秒之间", "err"); return; }
```

> 若业务上确实要支持 3650 天保留，则改后端上界为 3650（需同时确认 `cleanupExpiredLogs` 行为），但**两端必须一致**。

---

### P1-R5-6　rotate 模式仍会提交 anchorAt

**位置**：`src/web/index.html:4104`（字段 `showIf: modeIs("interval")`）+ `:4127`

`modalApplyVisibility` 只加 `hidden` class、**不清空值**，于是新建 rotate 分组时也会被写入一个无意义的 `anchorAt = 今天 HH:MM`；后端 `groupTimeError` 只校验格式，照单全收。

**修复方案**：

```js
// 4127：非 interval 模式不提交 anchorAt
anchorAt: vals.mode === "interval"
  ? (vals.anchorAt !== undefined ? vals.anchorAt : (g ? (g.anchor_at || "") : "")).trim()
  : (g ? (g.anchor_at || "") : ""),
```

---

## 四、🟡 Minor

| # | 位置 | 问题 | 修复建议 |
|---|---|---|---|
| m1 | `:3507` `escHtml`、`:3737` `escDdns` | 转义函数缺 `'`（与 `esc`/`escAttr` 不一致）。**当前不可利用**——逐处核对过，两者输出全部落在双引号属性或文本节点里，无单引号上下文 | 两个函数补 `.replace(/'/g, "&#39;")`；或直接 `const escHtml = esc; const escDdns = esc;` 消除漂移 |
| m2 | `:3009-3019` | `loadTriggers` 用模板字符串直接插值进 `innerHTML`，是全文件唯一未转义的动态拼接。**当前数据为硬编码常量，不可利用** | 改用 `esc()` 拼接（改法见前端子代理报告 m2） |
| m3 | `:3181`、`:3191` | 自建驱动命令只手工替换 `<`，漏了 `&`（`&&` 未转义）；相邻的 `data-copy-text` 已用完整 `escAttr`，两处口径不一 | `esc(cmd)` / `esc(uninstallCmd)` |
| m4 | `:2764` | `querySelector('#region-list option[value="' + current.replace(/"/g,'\\"') + '"]')` 只转义 `"` 未转义 `\`，用户输入含反斜杠时抛 `SyntaxError` 并中断 change 回调 | 改用 `Array.prototype.filter.call(document.querySelectorAll("#region-list option"), o => o.value === current)[0]` |
| m5 | `:2750`、`:2948`、`:3702`、`:4527` | 大量 async 函数直接交给 `addEventListener`，fetch 网络异常变成 unhandled rejection，用户无任何反馈；`handleDdnsAction`（`:4527`）浮动 Promise，DDNS 操作失败不可见 | 包一层 `safe(fn)`（见子代理报告 m7/m8），`handleDdnsAction` 加 `.catch` |
| m6 | `:2465` | `boot()` 里 `init-status` 请求无 try/catch（上一行的 `/status` 有），断网时停在登录骨架无提示 | `try { r = await apiJson(...) } catch { r = { ok:false, data:{} } }` |
| m7 | `:2689` | `lastUpdate` 用字符串比较时间戳，混有 ISO 与 D1 空格格式时会选错 | 改用 `parseDbTime(...).getTime()` 比较 |
| m8 | `:3580` + `server.ts:677-683` | API Key 有效期填 `0` / `-1`，后端静默降级为「永不过期」——**安全语义与用户预期相反** | 后端改为非法值 400；前端补 1–3650 校验 |

---

## 五、💭 Nit

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| n1 | `:2514-2525` | 首屏 `/api/v1/config` 打了两次（`loadConfig` 与 `loadAccountsManage` 各一次），而该接口要解密全部 AK/SK | `loadAccountsManage(cfg)` 支持复用，删掉 `enterApp` 里那次 |
| n2 | `:3429`、`:3371`、`:3498` | 保存通知/模板/保留天数成功后调用 `loadConfig()`，连带刷新触发源与 cron 密钥状态（+3 个无关请求） | 只回填对应表单，不整表重拉 |
| n3 | `schema.ts:186-212` | `DEFAULT_SETTINGS_MAP` 用 `adminPasswordHash: ['__skip_...','']` 占位 + `filter(k => !k.startsWith('__skip_'))` 的 hack（我自己引入的），脆弱 | 直接 `type SettingKey = Exclude<keyof Config, 'notifications'|'accounts'|'adminPasswordHash'>`，删掉占位键和 filter |
| n4 | `store.ts:859-880` | 注释声称「去掉了先 SELECT 再 UPDATE 的那次读」，但实际是 2 次 UPDATE 换 1 SELECT + 1 UPDATE，**调用数没减少**（语义修正是真的） | 修正注释，或改单条 `CASE` UPDATE 真正省掉一次 |
| n5 | `:4265` | 新加入成员 `sortOrder: next.length`，已有成员 order 为 10/20/30 时新成员会排到最前 | 取现有最大 order + 1，或保存时统一重排 |

---

## 六、✅ 肯定项（本轮确认做得对的）

- **上一轮 P0（SMTP 明文凭据）是真修好了**：`smtp.ts` 现在对非 465 端口强制校验服务器声明 `STARTTLS`、升级前 `release()` 释放流锁、升级后**重新 EHLO**，未声明则直接拒绝连接——宁可发不出邮件也不明文发凭据。这是全轮最有价值的一处修复。
- **P1-2/P1-3（阿里云）**：补上全项目唯一缺失的超时（10s）、退避加 `[0,400)ms` 抖动、`getInstanceBill` 从 3 页收敛到 1 页、尝试次数 3→2，并写了推导链注释。
- **P1-7（schemaReady 回归）**：用显式 `migrationOk` 布尔取代「用 `migrateFailures===0` 间接推导成功」，修掉了我在 `8e8e645` 引入的「成功后仍每请求重跑建表」缺陷。
- **P1-9**：`billingSnapshotMany` 用 `account_id IN` 把 summary 的账单查询从 N 次降到 1 次。
- **P2-7**：HMAC 缓存键改 SHA-256 摘要（不再把明文 AK Secret 留在 Map 键里），`clear()` 全清改 LRU 单条淘汰。
- **P2-8**：ECS 与 DDNS 的 `percentEncode` 合并为一处，消除了两份实现的漂移。
- **P1-5**：Spaceship 整组覆盖写加了完整性断言（数组缺失 / 分页不完整直接抛错），堵住「不可逆删掉 MX/TXT/CNAME」。
- **SQL 注入：未发现**。脚本命中的 6 处经人工逐条核实：`store.ts:216/236/242/250` 是常量 `CRON_SECRET_KEY`；`store.ts:763` 的 `IN (${placeholders})` 由 `kinds.map(()=>'?')` 生成；`ddns/store.ts:299/417` 的 `${sets.join(',')}` 全是字面量列名 —— 值一律走 `bind()`。
- **前端 XSS：未发现可利用点**。22 处 `innerHTML` 动态拼接逐处核对，全部使用转义函数；`title`/`desc`/`toast`/`showAlert` 一律 `textContent`。

---

## 七、复核签字

- 本报告所有行号均为本次会话现场 `grep` / `Read` 核实，未沿用历史报告中的定位（历史报告里的 `billingCache` 两处已确认修复：全仓仅剩 `store.ts:709` 一处定义 + 测试负向断言）。
- 静态脚本 6 条 SQL 命中、3 条「疑似密钥」命中，均已人工定性为**误报**（常量 / 占位符 / 限流键名）。
- P0-R5-2 与 P1-R5-4 是**我上一轮修复引入的新问题**，按标准文档阶段 3.6「修复的二次审查」要求，主动上报并已给出修复方案——修复不是风险的终点，修复是新代码。

---

## 八、下一步建议（按性价比排序）

1. **P0-R5-2** outbox 回填（1 行 SQL + 1 个测试）—— 我的回归，先修
2. **P0-R5-1** 日期控件补当前值（3 处小改 + 测试）—— 会改错 DNS 指向
3. **P1-R5-4** 定时间隔前端校验 —— 我新加的后端校验必须配前端，否则保存莫名失败
4. **P1-R5-1** 日志轮询加可见性判断 —— 额度收益最大
5. **P1-R5-3 / P1-R5-5 / P1-R5-6** 校验对齐（后端补 3 条、前端对齐 2 处范围、rotate 不提交 anchorAt）
6. **P1-R5-2** + Minor 一并返回

> 另：工作区尚有上一轮全库审查的 14 个文件未提交（已通过 tsc + 152 用例校验）。建议先提交这批，再按本报告修，避免两批改动混在一起难以回滚。
