# CDT Monitor (Cloudflare Worker 版)

CDT Monitor 的 Cloudflare Worker 移植版：阿里云 CDT 流量监控、ECS 实例自动化控制和费用观察，**完全运行在 Cloudflare 上，零服务器**。

> 原项目：https://github.com/wang4386/CDT-Monitor（Go 单机版）
> 本移植：用 Cloudflare Worker + D1 + Web Crypto 复刻核心功能（零服务器）

## 功能

- 多阿里云账号、地域、ECS 实例集中管理（凭据前台填写，AES-GCM 加密存 D1）
- CDT 国内/海外流量聚合与用量历史
- 可配置流量阈值：超限「停机并通知」或「仅通知」
- 停机模式：普通停机（KeepCharging）/ 节省停机（StopCharging），**支持账号级覆盖全局**
- 每日定时开关机、抢占式实例保活
- 手动开机、关机、刷新；账号概览卡片直接启停
- 账户余额与本月消费实时展示（含币种）
- 通知渠道：Telegram / 通用 Webhook（钉钉·飞书·企业微信）/ Server酱 / PushPlus / SMTP 邮件
- 自定义通知内容模板（`{{变量}}` 占位符，各渠道共用）
- 运行日志分类（登录/监控/告警）与分页、超期自动清理
- 首次安装向导、管理员登录、登录限速、修改密码、环境变量恢复密码
- 阿里云凭据 AES-GCM 加密，管理员密码 PBKDF2 哈希

## 与原版的差异（Worker 硬约束）

| 项 | 原 Go 版 | Worker 版 |
| --- | --- | --- |
| SMTP 邮件 | `net/smtp` 直连 | `cloudflare:sockets` TCP + 465 隐式 TLS |
| Telegram SOCKS5 | 支持 | 已放弃（无任意 TCP） |
| Telegram 自定义反代 | 支持 | 支持（HTTPS） |
| 管理员密码 | Argon2id | PBKDF2-SHA256 |
| 定时调度 | 进程内 Ticker | 外部 HTTP 触发 `/__cron`（不用 CF Cron，避免免费额度超限） |
| 存储 | SQLite | Cloudflare D1 |
| 通知渠道 | 邮件/Telegram/Webhook | 增加 Server酱、PushPlus，邮件改 SMTP |

## 目录结构

```
cdt-worker/
├── src/
│   ├── index.ts            # Worker 入口（fetch + scheduled）
│   ├── provider/aliyun.ts  # 阿里云 RPC 签名 + CDT/ECS/BSS 调用
│   ├── store/store.ts      # D1 数据访问 + 加密字段
│   ├── engine/engine.ts    # 监控循环 + 阈值/保活/定时策略
│   ├── notify/service.ts   # Telegram/Webhook/邮件
│   ├── security/security.ts# AES-GCM + PBKDF2 + Token
│   └── http/server.ts      # 路由 + 鉴权 + 限流
├── schema.sql              # D1 表结构
├── wrangler.toml
└── package.json
```

## 部署

1. 创建 D1 数据库（`cdt-monitor-db`）。**无需手动建表**——Worker 首次请求时会自动幂等建表。
2. 设置主密钥（32 字节 base64，用于加密阿里云凭据），通过 Dashboard 的 Secret 设置：
   ```bash
   npx wrangler secret put CDT_MASTER_KEY
   ```
3. 部署：
   ```bash
   npx wrangler deploy
   ```
4. 首次访问进入安装向导，设置管理员密码，然后在「设置」中添加阿里云账号（AK/Secret 会加密存储）。

> 更详细的 Dashboard 前台部署教程见 [DEPLOY-DASHBOARD.md](./DEPLOY-DASHBOARD.md)。

## 阿里云 RAM 权限（必读）

系统只调用 **6 个 OpenAPI**，请为它创建**专用 RAM 用户**，不要使用主账号 AccessKey。

### 系统实际调用的 API

| API | 用途 |
| --- | --- |
| `cdt:ListCdtInternetTraffic` | 读取 CDT 公网累积流量（核心监控数据） |
| `ecs:DescribeInstanceStatus` | 读取 ECS 实例运行状态 |
| `ecs:StartInstance` / `ecs:StopInstance` | 阈值自动停机、抢占式保活、每日定时开关机、手动启停 |
| `bss:QueryAccountBalance` | 账户余额（需在设置页开启「启用账单查询」） |
| `bss:DescribeInstanceBill` | 本月实例/账号账单金额（需开启「启用账单查询」） |

### 方案一 · 已验证可用的系统策略组合（最省事）

在 RAM 控制台 → 用户 → 新增授权，勾选以下**系统策略**，即可跑通全部功能（含账单与余额查询）：

| 系统策略 | 作用 | 是否必需 |
| --- | --- | --- |
| `AliyunCDTReadOnlyAccess` | 只读访问云数据传输（CDT） | ✅ 必需（流量监控） |
| `AliyunECSFullAccess` | 管理云服务器 ECS | ✅ 必需（实例状态读取 + 启停） |
| `AliyunBSSReadOnlyAccess` | 只读访问费用与成本（BSS） | 可选（余额 / 本月账单） |
| `AliyunCloudMonitorFullAccess` | 管理云监控 | ❌ 系统未使用，可不授权 |

> 实测：授予 `AliyunCDTReadOnlyAccess` + `AliyunECSFullAccess` + `AliyunBSSReadOnlyAccess`
> 即可正常查询流量、控制实例并拉取余额与本月账单金额。

**可移除的多余授权**（系统完全不使用）：`AliyunCDTFullAccess`、`AliyunBSSFullAccess`、
`AliyunCloudMonitorFullAccess`。只读权限即可满足，无需 FullAccess。

### 方案二 · 最小权限自定义策略（推荐，安全加固）

RAM → 权限策略 → 创建自定义策略（脚本编辑），粘贴以下 JSON：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "cdt:ListCdtInternetTraffic",
        "ecs:DescribeInstanceStatus",
        "ecs:StartInstance",
        "ecs:StopInstance",
        "bss:QueryAccountBalance",
        "bss:DescribeInstanceBill"
      ],
      "Resource": "*"
    }
  ]
}
```

不启用账单功能时，可删去两条 `bss:` 权限进一步收窄。
管理台「账号」页底部也提供同一份策略与一键复制。

## 定时监控（外部 HTTP 触发）

本项目**不使用 Cloudflare 自带 Cron**（免费额度仅 5 个，易超限），改用外部定时服务每 N 分钟请求一次 `/__cron` 接口触发监控：

```
https://你的worker地址/__cron
```

监控间隔在管理台「设置」里配置（默认 5 分钟），Worker 内部按此间隔防抖，外部频繁调用不会重复执行。

> 外部定时服务配置教程（cron-job.org / GitHub Actions 等）见 [DEPLOY-CRON.md](./DEPLOY-CRON.md)。

## 本地开发

```bash
npm install
npm run dev
```

## 邮件通知配置（MailChannels）

MailChannels 免费 API 要求发件域名在 Cloudflare DNS 中配置 SPF 和 DKIM：
- SPF：`v=spf1 include:_spf.mx.cloudflare.net ~all`
- DKIM：在 Cloudflare 开启「DKIM」并为邮件签名

## License

MIT（与原项目一致）
