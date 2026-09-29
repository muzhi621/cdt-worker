# CDT-Monitor · Cloudflare Worker 版

> 基于 **Cloudflare Workers + D1** 的阿里云 **CDT 流量监控 / ECS 控制 / 费用观察** 服务，并内置 **DDNS 轮换解析**。
> 单文件内联前端、无外部运维依赖、对免费额度友好、**无需绑定 KV**。

---

## 一、项目简介

CDT-Monitor 原本是一个 Go 项目，本仓库是其 **Cloudflare Worker 移植版**：把后端逻辑用 TypeScript 写在 Worker 里，数据全部落在 D1（SQLite 边缘数据库），前端是一个内联在 `src/web/index.html` 的单页应用（无需独立托管）。**不使用 KV**——所有"缓存"要么是 isolate 内存 Map，要么是 D1 的 `billing_cache` 表。

核心目标：**盯住阿里云 CDT（云数据传输）流量用量，逼近上限时自动停机 ECS 实例以规避超额费用**，并按多渠道通知告警；同时提供 DDNS 轮换解析，把域名自动指向当前在线的机器。

### 功能特性

| 分类 | 能力 |
| --- | --- |
| 账号管理 | 多阿里云账号（AK/SK 以 **AES-GCM 加密**存入 D1）；脱敏展示、备注、地域/实例/站点类型 |
| 流量监控 | 定时拉取 CDT 用量，聚合到小时/天；接近阈值时自动停机 ECS |
| 费用观察 | 余额 / 实例账单缓存，管理台可视化 |
| 通知 | 多渠道（SMTP、MailChannels、Webhook 等），支持自定义模板与 HMAC 签名 |
| 定时触发 | **双链路 + 多源冗余 + 内部防抖 + 原子槽位抢占**，无单点依赖 |
| DDNS 轮换 | 按天 / 基准时间+每 N 天 / 在线时段 / 固定首台 四种模式，支持多厂商 DNS |
| 鉴权与审计 | 管理员会话、API Key（仅存哈希）、操作审计日志、登录失败计数 |
| 安全 | 常量时间比较、IP 伪造防护、CSRF 双提交、参数化 SQL、跨 isolate 限流 |

---

## 二、架构概览

```
                        ┌──────────────────────────────────────────┐
   定时触发（多源） ───▶ │  /__cron  (X-Cron-Secret 鉴权)            │
   Cloudflare Cron ───▶ │  scheduled()  → runMonitorCycle()          │
                         │                                           │
   浏览器 / API ───────▶ │  src/http/server.ts  (路由 + 鉴权 + CSRF) │
                         │                                           │
                         │  src/engine/*   引擎（触发/时间/自托管）    │
                         │  src/store/*    D1 数据访问 + 建表         │
                         │  src/provider/* 阿里云调用（HMAC 签名）     │
                         │  src/notify/*   通知投递                    │
                         │  src/ddns/*     DDNS 轮换解析              │
                         │  src/security/* 安全工具                   │
                         └───────────────────────┬───────────────────┘
                                                 │
                                            D1 (DB)
```

- **栈**：Cloudflare Workers（TypeScript，`nodejs_compat`）+ D1 + 内联前端（无需 KV）
- **调度**：默认**外部定时服务**请求 `/__cron`（需 `CRON_SECRET`）；可选增强为 Cloudflare 原生 Cron（`scheduled()`，无需密钥）。两条链路共用内部防抖与原子抢占，多源并发只跑一轮。
- **建表**：`schema.sql` 可在部署后手动执行；运行时 `ensureSchema` 也会**幂等自动建表**（新增表无需手工迁移）。

### 目录结构

```
cdt-worker/
├── src/
│   ├── index.ts            # Worker 入口（fetch + scheduled）
│   ├── http/server.ts      # HTTP 路由 / 鉴权 / CSRF / 限流
│   ├── engine/             # 触发源、时间、自托管驱动生成
│   ├── store/              # D1 访问层 + schema
│   ├── provider/aliyun.ts  # 阿里云 API（HMAC 签名）
│   ├── notify/             # 通知服务 + SMTP
│   ├── ddns/               # DDNS 轮换解析
│   ├── security/           # 安全工具（常量时间比较、脱敏等）
│   └── web/index.html      # 单文件内联前端
├── docs/                   # DDNS / 自建触发 / 架构 / 审查等详细文档
├── schema.sql              # D1 建表语句
├── wrangler.toml          # 部署配置（D1 绑定、Cron）
├── selfhost/               # 自建触发驱动（install.sh / driver.mjs）
└── .github/workflows/      # GitHub Actions 定时触发
```

---

## 三、部署教程

> 前提：已有一个 Cloudflare 账号（**免费版即可**）。仓库：`https://github.com/muzhi621/cdt-worker`

### 方式 A：wrangler CLI（本地命令行）

```bash
cd cdt-worker
npm install                 # 安装依赖
npx wrangler login          # 浏览器授权（无浏览器见下方「常见问题」）
```

1. **创建 D1 数据库**
   ```bash
   npx wrangler d1 create cdt-monitor-db
   # 记下输出的 database_id
   ```
2. **回填 ID**：把 `wrangler.toml` 中的 `database_name` / `database_id` 指向你刚创建的库（最新 wrangler 可只填 `database_name` 幂等匹配云端资源，无需手写 id）。
   > **不需要创建 KV 命名空间**——代码未使用 KV，`wrangler.toml` 也没有 KV 绑定。
3. **初始化表结构**
   ```bash
   npx wrangler d1 execute cdt-monitor-db --remote --file=./schema.sql
   ```
   > 也可省略此步：Worker 首次请求时 `ensureSchema` 会幂等自动建表。
4. **设置主密钥**（见下文「环境变量与密钥」）。
5. **部署**
   ```bash
   npx wrangler deploy
   ```
   部署成功会输出 `https://cdt-monitor.<你的子域>.workers.dev`。

### 方式 B：Cloudflare 连接 GitHub（几乎纯前台，无需本地环境）

1. Cloudflare 控制台 → **Workers 和 Pages** → **创建** → 连接到 Git → 授权并选择 `muzhi621/cdt-worker`，生产分支 `main`，框架预设选 **Workers**，构建命令留空。
2. 前台创建 **D1**（`cdt-monitor-db`），把数据库名/ID 回填进 `wrangler.toml`（可用网页编辑器改仓库文件，或让 AI 助手代改）。**无需创建 KV**。
3. 设置主密钥、初始化表结构（D1 控制台逐条执行 `schema.sql`，或依赖 `ensureSchema` 自动建表）。
4. 保存并部署。

### 验证部署

- `https://你的地址/healthz` → `{"status":"ok"}`
- `https://你的地址/readyz` → `{"status":"ready"}`
- Cloudflare 控制台 → Worker → Logs 可看到监控/触发日志

### （可选）自定义域名

Worker 详情 → 设置 → 域和路由 → 添加自定义域名（自动 HTTPS）。

### （可选）邮件告警（MailChannels）

MailChannels 免费 API 要求发件域名经 Cloudflare DNS 验证：添加 SPF `v=spf1 include:_spf.mx.cloudflare.net ~all`，并在 Cloudflare 控制台开启 DKIM。

---

## 四、环境变量与密钥

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `CDT_MASTER_KEY` | **必填** | 32 字节 base64，用于 AES-GCM 加密阿里云凭据。**丢失后无法解密已存凭据**，务必备份 |
| `CRON_SECRET` | 推荐 | `/__cron` 外部触发密钥；两端（触发方 / Worker）须一致 |
| `ADMIN_PASSWORD` | 可选 | 忘记管理员密码时用于登录并重置（登录成功后同步为 D1 密码） |
| `DB`（D1 绑定） | 必填 | 数据库名 `cdt-monitor-db` |

> **KV 不需要绑定**：`Env` 接口只声明了 `DB`，全源码无任何 `KVNamespace` 引用；早期文档中的「创建 KV / CACHE」步骤为历史遗留，可安全跳过。已存在的 KV 命名空间留着不影响，也可删除。

> ⚠️ **切勿把任何密钥写进仓库文件**（包括 README）。`CDT_MASTER_KEY` 通过 `wrangler secret put` 或 Cloudflare 控制台的 Secrets 设置。

生成主密钥：

```bash
# macOS / Linux
openssl rand -base64 32
# Windows (PowerShell)
$key = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
```

设置：

```bash
npx wrangler secret put CDT_MASTER_KEY
npx wrangler secret put CRON_SECRET      # 可选
```

> Cloudflare 的 Secret 修改后需**重新部署一次**才生效。

---

## 五、首次使用

1. 浏览器打开 Worker 地址 → 进入**首次安装向导**，设置管理员密码（≥10 位）。
2. 登录后 → **账号**页添加阿里云 AK / Secret（自动加密存入 D1），填地域、实例 ID、流量上限、站点类型。
3. **设置**页配置阈值、停机模式、监控间隔。
4. 系统按调度自动监控；也可在状态页手动「立即监控」。

---

## 六、使用说明

- **账号**：增删阿里云账号，设置流量上限与自动停机；凭据密文与明文均不返回前端，界面仅显示脱敏值。

### 账号定时开关机：两种模式（互斥，只能启用其一）

| 模式 | 参数 | 语义 |
| --- | --- | --- |
| **每日定时开关机** | 开机时间 / 关机时间（HH:mm，按配置时区） | 每天在指定时刻开关机，命中窗口 ±2 小时（容忍外部 cron 延迟） |
| **基准时间 + N 天循环开关机** | 基准时间（默认取当前打开时间，可调）+ **初始状态（开机 / 关机）** + 周期天数 N（1~365） | 从基准时间起，按初始状态进入第 1 个相位，之后**每 N 天在开机 / 关机之间交替** |

示例 A（初始状态 = **开机**）：基准时间 `2026-09-30 00:00:00`、N = 10 →
`09-30 ~ 10-09 开机` → `10-10 ~ 10-19 关机` → `10-20 ~ 10-29 开机` ……（转换点每 10 天一次，落在基准时间的时刻上）。

示例 B（初始状态 = **关机**）：同样基准与 N →
`09-30 ~ 10-09 关机` → `10-10 ~ 10-19 开机` → `10-20 ~ 10-29 关机` ……（与示例 A 完全反相）。

> **为什么需要「初始状态」**：只给「基准时间 + N 天」无法定义循环从哪个状态起步——基准时刻到底是
> 开机起点还是关机起点没有显式约定时，首个相位的行为是不确定的。故必须指定初始状态，
> 默认「开机」（老数据升级后行为与历史语义一致，不会被静默反相）。

要点：

- 勾选其中一个会自动取消另一个（前端与后端双向保证），**不会同时生效**。
- 早于基准时间不执行任何启停；到达后按相位收敛（幂等键按「相位边界 + 动作」去重，同一相位只成功执行一次）。
- 监控在转换点断档也没关系：恢复后只要实例状态与目标相位不符就会补执行，不会漏掉整个相位。
- **保活会跟随相位**：关机相位内不会把实例拉起来，避免与循环策略打架。
- **按时性**：相位是**持续态**（不像每日定时依赖 ±2 小时命中窗口），所以不会「错过窗口」——
  指令最晚在**基准时刻之后的一个监控间隔内**发出（默认监控间隔 5 分钟；外部 cron 断档数小时，
  恢复后的第一轮也会立刻识别到当前相位并补执行）。
- **相位内被手动开/关机**会按天去重自动收敛回目标状态（每天最多补发一次，不会狂发指令）；
  指令执行失败则删键、下一轮自动重试。
- **配置无效会留痕**：启用了循环但基准时间/周期天数非法时，日志页每天告警一次，不会静默失效。
- 通知模板新增变量：`定时模式`、`开机时间`、`关机时间`、`循环基准时间`、`循环周期(天)`、`循环初始状态`。
- **监控**：查看实时用量、小时/天聚合曲线、ECS 实例状态；手动触发一轮监控。
- **设置**：阈值、停机模式、监控间隔（分钟，作为内部防抖窗口）、通知渠道、触发源开关。
- **通知**：SMTP（已做 CRLF 校验防注入）/ MailChannels / Webhook（支持 HMAC 签名），可自定义模板。
- **DDNS**：见下一节。
- **日志**：info / warning / error / audit / heartbeat / ddns 多分类，断档与切换都会留痕。

---

## 七、定时触发配置

### 双链路与鉴权

1. **主链路（默认）**：外部定时服务（GitHub Actions / cron-job.org / 自建驱动等）请求 `/__cron`，需携带 `CRON_SECRET`（`X-Cron-Secret` 头或 `?key=` 参数）。
2. **可选增强**：Cloudflare 原生 Cron（`wrangler.toml` 的 `[triggers] crons = ["*/5 * * * *"]`），`scheduled()` 直调内部监控函数，**无需密钥**。

`/__cron` **不再公开**：未配置 `CRON_SECRET` 时匿名外部请求得 `401`，仅管理员会话可触发。

### 触发渠道（建议至少开两个，避免单点断档）

| source | 渠道 | 说明 |
| --- | --- | --- |
| `github` | GitHub Actions | 仓库内置 `cron.yml`（每 5 分钟） |
| `http` | 外部定时服务 | cron-job.org 等 |
| `selfhost` | 自建驱动 / 云函数 | 见 `docs/SELFHOST.md` |
| `native` | Cloudflare 原生 Cron | 需账号 cron 额度 |
| `tencent` / `aliyun` / `huawei` | 腾讯云 SCF / 阿里云 FC / 华为云 FG | 大厂免费额度充足 |

> 渠道别名：`huawei`/`fg`/`huaweicloud`/`functiongraph`、`scf`/`tencentcloud`、`fc`/`alicloud` 均被识别。
> 未声明 `source` 的外部请求归为 `http`（该渠道默认关闭）——**渠道 URL 漏带 `?source=` 会导致记录落到默认关闭的 http 渠道，UI 表现为「断档」**，务必带上。

触发示例：

```bash
curl -H "X-Cron-Secret: <密钥>" "https://你的域名/__cron?source=github"
```

返回 `{"monitored": N, "interval_minutes": 5}`；`{"skipped": true, ...}` 表示刚运行过、被防抖跳过。

### 监控间隔如何配合

- **监控间隔（分钟）** = Worker 内部**防抖阈值**；**触发频率** = 实际触发频率。
- 触发频率高于间隔时自动跳过（不重复调用阿里云 API，也不刷新 `trigger_seen`，以免掩盖真实断档）。
- 原生 Cron 固定每 5 分钟调用一次；间隔 > 5 分钟时多轮被跳过属正常。

### 各渠道配置要点

- **GitHub Actions**：在 Worker 设 `CRON_SECRET`，仓库 Secrets 加同名 `CRON_SECRET`，Actions 页面可手动 Run。
- **cron-job.org**：URL 填 `/__cron?source=http`，Advanced 加 `X-Cron-Secret` 头，每 5 分钟。
- **华为云 FG / 腾讯云 SCF / 阿里云 FC**：建 Node.js 函数，环境变量 `CDT_URL`（带 `?source=`）、`CDT_SECRET`，配定时触发器（Cron 每 5 分钟）。代码模板见 `docs/SELFHOST.md` 与 `DEPLOY-CRON.md`。
- **自建驱动**：`docs/SELFHOST.md`（管理台可一键复制安装命令；脚本写 systemd 服务，无 Node/systemd 时降级 crontab + curl）。

> ⚠️ **额度提醒**：Cloudflare 免费版每账号仅 **5 个 Cron Trigger**（Paid 250）。若 `wrangler deploy` 报 `error 10072`，说明额度用尽——删掉 `wrangler.toml` 的 `[triggers]` 段重新部署（退回纯外部触发），或腾出其他 Worker 的额度。Dashboard 中**手工创建**的残留 cron 条目 wrangler 无法管理，需手动删除。

---

## 八、DDNS 轮换解析

> 场景：你有 2~5 台云服务器，在厂商控制台**错峰开关机**；本功能负责把域名解析自动切到当前在线的「值班机器」。机器开关机不由本系统控制。

与管理台共用同一套 D1、鉴权与日志，**无需额外部署**。

- **核心概念**：机器（名称+公网 IP）/ 分组（机器组+域名记录）/ DNS 凭据（独立配置、可复用、AES-GCM 加密）/ 解析记录（引用凭据）。
- **四种排班模式**：
  - `window`：按一天内时间段轮换（支持跨天）；
  - `rotate`：按每台机器各自的值班天数轮换（默认切换时刻 `03:00`，基准日 `1970-01-01`）；
  - `interval`：基准时间 + 每 N 天；
  - `static`：固定首台。
- **兜底**：全部离线时解析到分组兜底 IP；兜底留空则保持上次解析不变（不写坏）。
- **支持厂商**：Cloudflare、阿里云云解析、腾讯云 DNSPod、name.com、Spaceship、GoDaddy（凭据均 AES-GCM 加密，界面仅回脱敏值）。
- **同步与额度**：搭监控周期便车执行，**不额外占用 Cron 槽位**；幂等（仅目标 IP 与当前值不一致才写），按天轮换分组一天最多写一次。失败仅写日志，不影响监控主流程。

完整说明（概念/模式/厂商注意/接口/迁移）见 **`docs/DDNS.md`**。

---

## 九、自建驱动与大厂免费触发

不要把所有触发押在单一渠道（GitHub Actions 高峰会延迟/丢跑，长期无提交会被禁用）。冗余方案：

- **自建驱动**：管理台「监控触发源 → 自建驱动」复制一键命令，或从仓库 `selfhost/` 取 `install.sh`（交互/非交互/`--docker`/`--uninstall`）。
- **腾讯云 SCF / 阿里云 FC / 华为云 FG**：长期免费额度充足，定时触发器 + HTTP 请求即可。
- **cron-job.org**：免费，第二渠道首选。

详细步骤与函数代码模板见 **`docs/SELFHOST.md`** 与 **`DEPLOY-CRON.md`**。

---

## 十、安全设计说明（基于代码审查）

- **密钥与凭据**：阿里云 AK/SK、DNS 凭据均以 AES-GCM 加密存储；明文/密文均不返回前端，仅回脱敏值（如 `abc****xyz`）。
- **鉴权**：管理员会话（HttpOnly Cookie + CSRF 双提交校验）；API Key 仅存哈希。
- **常量时间比较**：密钥 / token 比较使用常量时间算法，抵御时序侧信道。
- **IP 伪造防护**：X-Forwarded-For 等多层头按 Cloudflare 语义取真实客户端 IP，防伪造绕过限流/审计。
- **SQL 注入**：全部参数化查询（`bind`），拼接仅用于常量键。
- **限流**：高敏端点采用**跨 isolate 的 D1 计数 + 内存快速层**双闸（登录失败另有 D1 跨实例计数兜底），避免多 isolate 下内存限流失效。
- **SMTP**：发送前校验发件/收件地址无控制字符，防 CRLF 命令/头注入。
- **免费额度管控**：每轮 cron 严格估算 subrequest 数量，避免触发 50 subrequest 上限中断整轮。

---

## 十一、开发与测试

```bash
npm install        # 安装依赖
npm run dev        # 本地 wrangler dev
npm run deploy     # 部署（等价 wrangler deploy）
npm run typecheck  # tsc --noEmit 类型检查
npm test           # vitest run
```

> **Windows 已知 flake**：并行跑 vitest 时多个 worker 并发写同一 SSR 缓存文件会触发 `EPERM`，且会静默漏载测试文件、计数虚低。**请串行运行**以确保 15 文件 / 154 用例全绿：
> ```bash
> rm -rf .tmp-vitest && mkdir -p .tmp-vitest
> env -u NODE_OPTIONS TMP="$PWD/.tmp-vitest" TEMP="$PWD/.tmp-vitest" TMPDIR="$PWD/.tmp-vitest" \
>   npx vitest run --no-file-parallelism
> ```
> 类型检查务必 0 error 后再提交。

---

## 十二、免费额度约束（务必遵守）

| 资源 | 限制 | 应对 |
| --- | --- | --- |
| 单次请求 subrequest | **50** | 每轮 cron 估算 subrequest 数，超额会 1101 中断整轮 |
| D1 读 | 5M 行/天 | 聚合查询、结果存 D1 `billing_cache` 表减少重复读 |
| CPU | 10ms/请求（Free） | 监控周期拆分为幂等小步，避免单次超时 |

DDNS 同步、通知投递均设计为低 subrequest、幂等、失败隔离，确保不挤占主监控预算。

---

## 十三、常见问题

**Q1：监控没自动跑？**
检查「监控触发源」各渠道开关与「上次触发」时间戳是否在走动；确认「设置」页监控间隔未把频率压得过低；外部链路需 `CRON_SECRET` 两端一致且请求带 `X-Cron-Secret`。手动验证：`curl -H "X-Cron-Secret: 密钥" https://你的地址/__cron`。

**Q2：外部请求 `/__cron` 返回 401？**
未配置 `CRON_SECRET` → 匿名请求一律 401（预期）；已配置则检查密钥一致性与请求头/参数。

**Q3：部署报 `error 10072`？**
账号 Cron Trigger 免费额度（5 个/账号）已用尽。删除 `wrangler.toml` 的 `[triggers]` 段重部署，或腾出其他 Worker 额度、升级 Paid。

**Q4：主密钥丢了？**
已加密的阿里云凭据无法解密，需重置 `CDT_MASTER_KEY` 并在管理台重新填写所有账号 AK/Secret。**务必备份主密钥**。

**Q5：npm install 卡住？**
多为代理导致，禁用后重装：`unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY && npm install`（Windows PowerShell 设对应变量为空）。

**Q6：Secret 改了不生效？**
Cloudflare Secret 修改后需**重新部署一次**才生效。

**Q7：GitHub 授权找不到仓库？**
授权时勾选「所有仓库」或把 `cdt-worker` 加入授权范围后刷新。

**Q8：构建失败？**
确认 `wrangler.toml` 中 D1 的真实 ID/库名已填入；查看部署详情页构建日志。

**Q9：需要绑定 KV（CACHE）吗？**
**不需要**。代码只使用 D1，`Env` 接口无 KV 声明，`wrangler.toml` 也没有 KV 绑定。部分旧文档（`DEPLOY.md` / `DEPLOY-DASHBOARD.md`）里的 KV 步骤是历史遗留，可跳过；已创建的 KV 留着不影响，也可删除以保持账号整洁。

---

## 十四、部署检查清单

- [ ] `wrangler login`（或 API Token）成功
- [ ] D1 数据库 `cdt-monitor-db` 已创建并绑定
- [ ] `schema.sql` 已执行（或依赖 `ensureSchema` 自动建表）
- [ ] `CDT_MASTER_KEY` 已设置并**备份**
- [ ] `CRON_SECRET` 已设置（如使用外部触发）
- [ ] `wrangler deploy` 成功
- [ ] `/healthz`、`/readyz` 返回正常
- [ ] 首次安装向导完成，管理员密码已设置
- [ ] 至少配置两个触发渠道（冗余）

---

## 十五、详细文档索引

| 文档 | 内容 |
| --- | --- |
| `DEPLOY.md` | wrangler CLI 完整部署教程 |
| `DEPLOY-DASHBOARD.md` | Cloudflare 连接 GitHub 纯前台部署 |
| `DEPLOY-CRON.md` | 定时触发全渠道配置（含各云函数代码） |
| `docs/DDNS.md` | DDNS 轮换解析完整说明 |
| `docs/SELFHOST.md` | 自建驱动与大厂免费触发方案 |
| `docs/architecture-*.md` | 架构设计记录 |
| `docs/review-*.md`、`docs/audit-*.md` | 代码审查与整改记录 |

---

## 许可证

详见仓库 LICENSE（如未提供，默认保留原作者版权）。
