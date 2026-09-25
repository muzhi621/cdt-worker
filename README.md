# CDT Monitor (Cloudflare Worker 版)

CDT Monitor 的 Cloudflare Worker 移植版：阿里云 CDT 流量监控、ECS 实例自动化控制和费用观察，**完全运行在 Cloudflare 上，零服务器**。

> 原项目：https://github.com/wang4386/CDT-Monitor（Go 单机版）
> 本移植：用 Worker + D1 + KV + Cron + Web Crypto 复刻核心功能

## 功能

- 多阿里云账号、地域、ECS 实例集中管理（凭据前台填写，AES-GCM 加密存 D1）
- CDT 国内/海外流量聚合与用量历史
- 可配置流量阈值：超限「停机并通知」或「仅通知」
- 普通停机（KeepCharging）/ 节省停机（StopCharging）
- 每日定时开关机、抢占式实例保活
- 手动开机、关机、刷新
- Telegram / 自定义 Webhook / 邮件（MailChannels）通知
- 中国站 / 国际站 BSS 余额与账单缓存
- 首次安装向导、管理员登录、API Key（scope 权限）、登录限速
- 阿里云凭据 AES-GCM 加密，管理员密码 PBKDF2 哈希

## 与原版的差异（Worker 硬约束）

| 项 | 原 Go 版 | Worker 版 |
| --- | --- | --- |
| SMTP 邮件 | `net/smtp` 直连 | MailChannels 免费 API |
| Telegram SOCKS5 | 支持 | 已放弃（无任意 TCP） |
| Telegram 自定义反代 | 支持 | 支持（HTTPS） |
| 管理员密码 | Argon2id | PBKDF2-SHA256 |
| 定时调度 | 进程内 Ticker | Cron Trigger（分钟级） |

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
