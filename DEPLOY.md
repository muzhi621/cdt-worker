# CDT-Monitor Worker 版 · Cloudflare 部署教程

> 适用：`https://github.com/muzhi621/cdt-worker`
> 前提：已有一个 Cloudflare 账号（免费版即可）

---

## 0. 准备：安装与登录

### 安装 Node.js 与 wrangler

```bash
# 进入项目目录
cd cdt-worker

# 安装依赖（本机若 npm 卡住，参考文末「常见问题」禁用代理）
npm install

# 登录 Cloudflare（会打开浏览器授权）
npx wrangler login
```

> 注意：`wrangler login` 需要浏览器交互。若在无浏览器服务器上，改用：
> `npx wrangler login --scopes-list` 获取权限后，用 `CLOUDFLARE_API_TOKEN` 环境变量登录（见文末）。

---

## 1. 创建 D1 数据库

```bash
npx wrangler d1 create cdt-monitor-db
```

输出示例：

```text
✅ Created database 'cdt-monitor-db' with database_id 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
```

**记下 `database_id`**，下一步要用。

---

## 2. 创建 KV 命名空间

```bash
npx wrangler kv namespace create CACHE
```

输出示例：

```text
✅ Created namespace "CACHE" with id "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"
```

**记下这个 `id`**。

---

## 3. 修改 wrangler.toml 填入真实 ID

打开 `wrangler.toml`，把两处占位符替换为上面的真实值：

```toml
[[d1_databases]]
binding = "DB"
database_name = "cdt-monitor-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"   # ← 换成第 1 步的 database_id

[[kv_namespaces]]
binding = "CACHE"
id = "yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy"                 # ← 换成第 2 步的 namespace id
```

---

## 4. 初始化数据库表结构

```bash
npx wrangler d1 execute cdt-monitor-db --remote --file=./schema.sql
```

输出应显示若干 `CREATE TABLE` 执行成功，无报错。

---

## 5. 设置主密钥（用于加密阿里云凭据）

先生成一个 32 字节的 base64 密钥：

```bash
# Windows (PowerShell)：
$key = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))

# macOS / Linux：
openssl rand -base64 32
```

把生成的字符串保存好（**务必备份，丢失后无法解密已存的阿里云凭据**），然后写入 Secret：

```bash
npx wrangler secret put CDT_MASTER_KEY
# 粘贴上面生成的 base64 字符串，回车
```

---

## 6. 部署

```bash
npx wrangler deploy
```

部署成功后，wrangler 会输出你的 Worker 地址，形如：

```text
https://cdt-monitor.<你的子域名>.workers.dev
```

---

## 7. 首次使用

1. 浏览器打开上面的 Worker 地址
2. 会进入**首次安装向导**，设置管理员密码（至少 10 位）
3. 登录后，在「账号」页添加阿里云账号：
   - 填入 AccessKey ID / AccessKey Secret（自动加密存 D1）
   - 地域、实例 ID、流量上限、站点类型
4. 在「设置」页配置阈值、停机模式等
5. 系统会按 Cron（每 5 分钟）自动监控，也可在状态页手动刷新

---

## 8. 验证

- `https://<你的地址>/healthz` → 返回 `{"status":"ok"}`
- `https://<你的地址>/readyz` → 返回 `{"status":"ready"}`
- 在 Cloudflare 控制台 → Workers → cdt-monitor → 日志，可看到 Cron 触发的监控日志

---

## 9.（可选）绑定自定义域名

1. Cloudflare 控制台 → Workers & Pages → 你的 worker → 设置 → 域和路由
2. 添加自定义域名（如 `cdt.yourdomain.com`）
3. 绑定后即可用该域名访问（自动 HTTPS）

---

## 10. 邮件通知配置（仅当你用邮件告警）

MailChannels 免费 API 要求发件域名通过 Cloudflare DNS 验证：

1. 域名托管在 Cloudflare
2. 添加 SPF 记录：`v=spf1 include:_spf.mx.cloudflare.net ~all`
3. 在 Cloudflare 控制台 → 你的域名 → 电子邮件 → 开启 DKIM
4. 邮件配置里，发件地址（username）填你的域名邮箱

---

## 常见问题

### Q1：npm install 卡住 / 超时

本机可能配置了代理导致 npm 走代理失败。禁用代理后重装：

```bash
# Windows (PowerShell)：
$env:HTTP_PROXY=''; $env:HTTPS_PROXY=''; $env:http_proxy=''; $env:https_proxy=''; npm install

# macOS / Linux：
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY && npm install
```

### Q2：wrangler login 无法在无浏览器环境登录

用 API Token 方式：

1. Cloudflare 控制台 → 我的个人资料 → API 令牌 → 创建令牌 → 选「Edit Cloudflare Workers」模板
2. 复制 token，设置环境变量：
   ```bash
   export CLOUDFLARE_API_TOKEN="你的token"
   ```
3. 之后 wrangler 命令会自动使用该 token

### Q3：Cron 没触发监控

- 检查 Cloudflare 控制台 → 你的 worker → 设置 → Cron 触发器，确认 `*/5 * * * *` 已配置
- 免费版 Cron 触发也正常可用

### Q4：主密钥丢了怎么办

主密钥（CDT_MASTER_KEY）丢失后，已加密的阿里云凭据无法解密。需要重新设置密钥，并在管理台重新填写所有账号的 AK/Secret。因此**务必备份主密钥**。

---

## 部署检查清单

- [ ] `wrangler login` 成功
- [ ] D1 数据库已创建，ID 已填入 wrangler.toml
- [ ] KV 命名空间已创建，ID 已填入 wrangler.toml
- [ ] `schema.sql` 已执行（d1 execute）
- [ ] `CDT_MASTER_KEY` 已设置并备份
- [ ] `wrangler deploy` 成功
- [ ] `/healthz` 和 `/readyz` 返回正常
- [ ] 首次安装向导完成，管理员密码已设置
