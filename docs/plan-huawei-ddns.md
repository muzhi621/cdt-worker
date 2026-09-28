# cdt-worker 融合方案：华为云函数触发渠道 + DDNS 轮换

> 状态：计划阶段，待用户审阅后再进入开发。

---

## 一、现状与需求拆解

### 1.1 截图反映的当前状态

从管理台截图可见：

| 渠道 | 状态 | 上次触发 |
|---|---|---|
| GitHub Actions | 已关闭 | 1 天前 |
| 外部定时服务 | 已关闭 | 从未触发 |
| 自建驱动 | 已关闭 | 从未触发 |
| Cloudflare 原生 Cron | 已关闭 | 1 天前 |
| 腾讯云 SCF | 已关闭 | 从未触发 |
| 阿里云 FC | 已开启 | 1 分钟前 |

当前只剩 **阿里云 FC** 一个触发源。用户反馈：

1. **阿里云开始收费** → 需要一条免费的替代渠道。
2. **Cloudflare 原生 Cron 好像触发有问题** → 需要排查 CF Cron 未触发/显示未触发的根因。
3. **华为云函数有免费额度** → 新增「华为云函数 FG」触发渠道，并提供配置教程。
4. **融合 [muzhi621/ddns-rotation](https://github.com/muzhi621/ddns-rotation)** → 在 cdt-worker 内增加 DDNS 轮换能力：
   - 可选多个域名；
   - 支持按月 / 按天 / 按机器（如 A 10 天、B 10 天、C 10 天）交替轮换；
   - 解析到同一个域名。

### 1.2 需求优先级建议

| 优先级 | 事项 | 理由 |
|---|---|---|
| P0 | 华为云函数触发渠道 |  immediate 节省成本，保持监控不中断 |
| P1 | 修复/确认 CF 原生 Cron 不触发问题 | 免费且最稳的渠道，不应长期关闭 |
| P2 | DDNS 轮换功能融合 | 新能力，架构改动大，需单独设计 |
| P3 | 文档与教程更新 | 随功能一起交付 |

---

## 二、华为云函数触发渠道（P0）

### 2.1 现有触发渠道架构

源码位置：`src/engine/triggers.ts`、`src/http/server.ts`、`src/web/index.html`。

- `TriggerSource` 当前枚举：`github | http | selfhost | native | tencent | aliyun`。
- 默认开关：`native=true, selfhost=true`，其余默认关。
- 识别方式：外部请求通过 `?source=xxx` 或 `X-Trigger-Source: xxx` 声明来源；`normalizeSource()` 做标准化。
- 鉴权：统一通过 `CRON_SECRET`（D1 托管或 Worker Secret）。
- 状态：D1 `settings` 表中 `trigger_sources`（开关 JSON）和 `trigger_seen`（上次触发时间戳 JSON）。
- 前端：`<div id="trigger-list">` 按 `TRIGGER_LABELS` 动态渲染开关、上次触发时间、测试按钮。

### 2.2 新增华为云函数的最小改动点

| 文件 | 改动内容 |
|---|---|
| `src/engine/triggers.ts` | 在 `TriggerSource` 类型、`TRIGGER_SOURCES`、`TRIGGER_LABELS`、`DEFAULT_TRIGGER_SOURCES` 中新增 `huawei: '华为云函数 FG'`；`normalizeSource()` 增加 `huawei / fg / huaweicloud` 别名映射。 |
| `src/http/server.ts` | 无改动即可工作（`normalizeSource` 标准化后的来源会进入统一开关判断）。 |
| `src/web/index.html` | ① 触发渠道列表会自动读取 `TRIGGER_LABELS`，无需硬编码；② 在教程区新增「⑥ 华为云函数 FG」配置步骤与示例代码；③ 更新 `initTutorialVars()` / `renderTutorial()` 中的 URL/Cron 生成逻辑。 |
| `DEPLOY-CRON.md` | 新增华为云函数部署教程。 |

### 2.3 华为云函数示例代码

华为云函数工作流（FunctionGraph）Node.js 18/20 触发器代码：

```js
const url = process.env.CDT_URL;
const secret = process.env.CDT_SECRET;

exports.handler = async (event, context) => {
  const res = await fetch(url + '?source=huawei', {
    method: 'POST',
    headers: {
      'X-Cron-Secret': secret,
      'X-Trigger-Source': 'huawei',
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  return {
    statusCode: res.status,
    body: text,
    headers: { 'Content-Type': 'application/json' },
  };
};
```

> 华为云 FG 免费额度：每月 100 万次调用 + 40 万 GB·秒，每 5 分钟一次绰绰有余。

### 2.4 CF 原生 Cron「好像不触发」的排查计划

截图显示 CF 原生 Cron「已关闭 / 上次触发 1 天前」。需要先确认是**真不触发**还是**开关被关**导致未触发：

1. 在管理台打开 `Cloudflare 原生 Cron` 开关；
2. 检查 `wrangler.toml` 中 `[triggers] crons` 是否仍然保留 `"*/5 * * * *"`；
3. 观察 10–15 分钟后「上次触发时间」是否更新；
4. 若仍不更新，到 Cloudflare Dashboard → Workers & Pages → cdt-worker → Observability → Logs 查看 `scheduled` 事件；
5. 如果 Dashboard 显示有 `scheduled` 事件但前端未更新，检查 `noteTriggerDisabled` / `shouldNativeRun` 逻辑是否因监控间隔节流而跳过。

---

## 三、DDNS 轮换功能融合（P2）

### 3.1 ddns-rotation 仓库能力摘要

[muzhi621/ddns-rotation](https://github.com/muzhi621/ddns-rotation) 是一个独立的 Cloudflare Worker + D1 + Cron 项目，核心能力：

- **数据模型**：machine、group、group_domain、credential、logs。
- **排班模式**：
  - `window`：按在线时段（支持跨天）；
  - `rotate`：按天轮转，可设 `switch_time` 与 `anchor_date`；
  - `static`：固定首台。
- **DNS 厂商**：Cloudflare、阿里云、腾讯云 DNSPod、name.com、none（演练）。
- **幂等同步**：目标 IP 未变化时不调用厂商 API。
- **API**：Hono 框架，RESTful 接口。

### 3.2 融合方式对比

| 方案 | 说明 | 优点 | 缺点 |
|---|---|---|---|
| A. 独立部署，API 联动 | cdt-worker 通过 HTTP 调用 ddns-rotation 的 `/api/sync` | 改动小、各自独立演进 | 多一个 Worker + D1，跨 Worker 调用消耗 subrequest；华为云免费场景下增加管理成本 |
| B. 代码级融合进 cdt-worker | 把 ddns-rotation 的核心模块（scheduler + DNS provider）搬进 cdt-worker | 统一入口、统一日志、统一鉴权、复用现有 D1 | 改动面大，需要把 Hono 路由/ORM 改成 cdt-worker 的无框架风格 |
| **推荐** | **B：代码级融合**，但分阶段交付 | 长期维护成本最低，符合用户「融合进去」的语义 | 需要 1 轮完整重构 |

### 3.3 数据模型设计（复用 cdt-worker 的 D1）

新增 3 张表：

```sql
-- DDNS 机器（与阿里云 ECS 账号解耦，可填任意 IP）
CREATE TABLE IF NOT EXISTS ddns_machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ip TEXT NOT NULL,
  remark TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- DDNS 分组（一个分组 = 多台机器 + 一个/多个域名记录）
CREATE TABLE IF NOT EXISTS ddns_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'rotate',   -- window | rotate | static
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  switch_time TEXT NOT NULL DEFAULT '03:00',
  anchor_date TEXT NOT NULL DEFAULT '1970-01-01',
  fallback_ip TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 分组机器成员与时段（mode=window 时生效）
CREATE TABLE IF NOT EXISTS ddns_group_members (
  group_id INTEGER NOT NULL,
  machine_id INTEGER NOT NULL,
  window_start TEXT,                      -- HH:MM
  window_end TEXT,                        -- HH:MM
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, machine_id),
  FOREIGN KEY (group_id) REFERENCES ddns_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (machine_id) REFERENCES ddns_machines(id) ON DELETE CASCADE
);

-- 解析记录（一个分组可挂多条记录/多个域名）
CREATE TABLE IF NOT EXISTS ddns_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  provider TEXT NOT NULL,                 -- cloudflare | aliyun | dnspod | namecom | none
  domain TEXT NOT NULL,                   -- 完整域名，如 www.example.com
  record_type TEXT NOT NULL DEFAULT 'A',
  ttl INTEGER NOT NULL DEFAULT 60,
  zone_id TEXT NOT NULL DEFAULT '',
  record_id TEXT NOT NULL DEFAULT '',
  credential_enc TEXT NOT NULL DEFAULT '', -- AES-GCM 加密，复用现有 crypto 工具
  current_ip TEXT NOT NULL DEFAULT '',
  last_sync_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (group_id) REFERENCES ddns_groups(id) ON DELETE CASCADE
);

-- DDNS 执行日志（复用 logs 表，type='ddns'）
-- 也可单开 ddns_logs 表，避免污染；建议复用 logs，message 区分即可。
```

### 3.4 轮换策略详细设计

#### rotate 按天轮转

```ts
// 以 anchor_date 为基准，计算从基准日到今天的偏移天数
const offsetDays = Math.floor((today - anchorDate) / 86400000);
const idx = offsetDays % machines.length;
const active = machines[idx];
```

- 支持「A 10 天、B 10 天、C 10 天」：把每台机器配一个 `duration_days` 字段，按累计权重取模。
- `switch_time` 之前仍指向前一天的结果，避免开机时间错位。

#### window 在线时段

- 每台机器在 `ddns_group_members` 中设置 `window_start` / `window_end`（支持跨天）。
- 按分组 `timezone` 转换当前时间，命中谁的窗口就解析给谁。
- 都不在线 → `fallback_ip`（留空则保持当前解析）。

#### static 固定首台

- 取 `sort_order` 最小的机器 IP。

### 3.5 DNS Provider 适配

复用 ddns-rotation 的 provider 实现，改写成 cdt-worker 风格（无 Hono、无外部依赖）：

| Provider | 关键 API |
|---|---|
| Cloudflare | `GET /zones?name=<domain>` → `PUT /zones/<zone_id>/dns_records/<record_id>` |
| 阿里云 | `DescribeDomainRecords` → `UpdateDomainRecord` |
| 腾讯云 DNSPod | `DescribeRecordList` → `ModifyRecord` |
| name.com | `GET /v4/domains/<domain>/records` → `PUT /v4/domains/<domain>/records/<record_id>` |

> 幂等：目标 IP 与 `current_ip` 一致时不调用 API，仅刷新时间戳。

### 3.6 调度触发方式

两种触发源：

1. **复用现有 CF 原生 Cron**：在 `scheduled()` 中加入 `runDdnsSync(env)` 调用。
2. **由监控轮次顺带触发**：在 `runMonitorCycle` 末尾调用 `runDdnsSync(env)`，保持「所有自动化由监控周期驱动」的统一心智。

**推荐**：方案 2，因为用户已经在使用外部触发渠道驱动监控，DDNS 不需要单独的 Cron Trigger，可省 CF Cron 槽位和调用次数。

### 3.7 前端 UI 规划

新增一个「DDNS 轮换」Tab（与「账号」「设置」「通知」并列）：

- **机器列表**：增删改查机器名称/IP/启用状态。
- **分组列表**：名称、模式（rotate/window/static）、时区、switch_time、fallback_ip。
- **分组详情**：
  - 成员机器拖拽排序；
  - window 模式显示时段输入；
  - rotate 模式显示 duration_days；
  - 解析记录管理（多域名、provider 选择、凭据、zone_id/record_id 自动回填）。
- **预览**：未来 7 天/小时的轮换结果。
- **手动同步按钮**：立即执行一次 `runDdnsSync`。

### 3.8 API 设计

```
GET    /api/v1/ddns/machines
POST   /api/v1/ddns/machines
PUT    /api/v1/ddns/machines/:id
DELETE /api/v1/ddns/machines/:id

GET    /api/v1/ddns/groups
POST   /api/v1/ddns/groups
PUT    /api/v1/ddns/groups/:id
DELETE /api/v1/ddns/groups/:id
PUT    /api/v1/ddns/groups/:id/members

GET    /api/v1/ddns/records
POST   /api/v1/ddns/records
PUT    /api/v1/ddns/records/:id
DELETE /api/v1/ddns/records/:id

POST   /api/v1/ddns/sync            # 手动同步
GET    /api/v1/ddns/preview         # 预览未来轮换
```

---

## 四、CF 免费资源影响评估

| 资源 | 当前占用 | 新增后估算 | 备注 |
|---|---|---|---|
| Worker 请求数 | 100,000/天（cron 5 分钟 ≈ 288 次） | 不变 | DDNS 复用监控轮次 |
| Subrequests / 请求 | 非刷新轮 ≈18，刷新轮 ≈28 | +2~4 / DNS provider | 仅 IP 变化时调用 |
| CPU time | 5 账号 ≈ 6–9 ms | +1–3 ms | DDNS 计算轻量 |
| D1 写入 | 5 账号 ≈ 6,000–9,000/天 | +少量 | 每次同步写状态/日志 |
| D1 存储 | 日志滚动清理 | 新增 3 表 + 记录历史 | 小 |

结论：在 CF Free 额度内可安全运行，DNS 调用只在 IP 变化时发生。

---

## 五、阶段划分与交付物

### 阶段 1：华为云函数触发渠道（1–2 天）

- [ ] 修改 `src/engine/triggers.ts` 新增 `huawei`。
- [ ] 前端教程区新增华为云 FG 配置示例。
- [ ] 更新 `DEPLOY-CRON.md`。
- [ ] 本地 `tsc --noEmit` + `vitest` 通过。
- [ ] 用户部署到华为云 FG 并验证触发。

### 阶段 2：CF 原生 Cron 触发问题排查（可与阶段 1 并行）

- [ ] 确认开关、wrangler.toml、Dashboard Logs。
- [ ] 如代码有 bug，修复 `shouldNativeRun` / `noteTriggerDisabled` 逻辑。
- [ ] 补充单测覆盖跳过/节流场景。

### 阶段 3：DDNS 数据模型与后端（3–4 天）

- [ ] 新增 `schema.sql` 三张表。
- [ ] 实现 `src/ddns/` 目录：
  - `scheduler.ts`：排班算法；
  - `providers/`：cloudflare.ts、aliyun.ts、dnspod.ts、namecom.ts；
  - `sync.ts`：同步主流程；
  - `store.ts`：数据访问层。
- [ ] 实现 API 路由（`src/http/server.ts` 新增 9 个路由）。
- [ ] 在 `runMonitorCycle` 末尾调用 DDNS 同步。
- [ ] 单测覆盖排班算法和 provider 幂等逻辑。

### 阶段 4：DDNS 前端 UI（2–3 天）

- [ ] 新增「DDNS 轮换」Tab。
- [ ] 机器/分组/记录 CRUD。
- [ ] 预览未来轮换结果。
- [ ] 手动同步按钮与结果反馈。

### 阶段 5：文档与集成测试（1 天）

- [ ] 更新 `README.md` 和 `DEPLOY-DASHBOARD.md`。
- [ ] 端到端测试：华为云 FC 触发 → 监控 → DDNS 切换。
- [ ] 推送到 GitHub，用户 `wrangler deploy`。

---

## 六、关键风险与决策点

| 风险 | 影响 | 建议 |
|---|---|---|
| DDNS 与阿里云 ECS 账号体系混淆 | 用户可能以为 DDNS 机器就是 cdt 账号 | UI 明确区分「云账号监控」与「DDNS 机器」 |
| DNS 厂商 API 凭据泄露 | credential_enc 需复用 AES-GCM 加密 | 复用现有 `security.ts` 加密工具 |
| 多域名切换时 TTL 缓存 | 用户访问仍指向旧 IP | 文档提示 TTL 设置和缓冲时间 |
| 华为云 FG 与阿里云 FC 同时触发 | 渠道冗余会触发监控轮次，但 Worker 内部有 45 秒余量防抖 | 按现有间隔设置 5 分钟即可 |
| DDNS 融合改动面大 | 可能引入回归 | 每个阶段单独测试、单独提交 |

---

## 七、需要你拍板的决策

1. **是否按 P0→P1→P2 分阶段交付？** 还是一次性全做？
2. **DDNS 融合选方案 B（代码级融合）还是方案 A（独立 Worker，cdt 通过 API 调用）？**
3. **CF 原生 Cron 不触发**：需要你现在打开开关并观察 10 分钟，我据此判断是配置问题还是代码 bug。
4. **DDNS 域名轮换的「按机器 10 天交替」**：是否还需要支持「按自然月」「按自然天」这两种固定周期？
5. **DNS Provider 优先级**：先做 Cloudflare + 阿里云，还是三家（+ DNSPod）一起做？

---

## 八、下一步行动

如果你确认按此计划推进，我会：

1. 先实现 **阶段 1（华为云函数触发渠道）** + **阶段 2（CF Cron 排查）**；
2. 推送 GitHub 后，你部署到华为云 FG 验证；
3. 确认触发渠道稳定后，再进入 **阶段 3/4（DDNS 融合）**。

请回复：
- 「按阶段推进」或「一次性全做」；
- DDNS 融合方案偏好（B 推荐）；
- 当前 Cloudflare 原生 Cron 开关是否已打开。
