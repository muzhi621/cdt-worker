# CDT-Monitor · Cloudflare 前台部署教程（GitHub 集成方式）

> 本方式通过 Cloudflare 连接 GitHub 仓库自动构建部署，**几乎全程在网页点鼠标**。
> 代码已在 `https://github.com/muzhi621/cdt-worker`。

---

## 全流程概览

```
① 创建 D1（前台）        ┐
② 创建 KV（前台）        ├─ 记下两个 ID
③ 回填 ID 到仓库          ┘
④ 连接 GitHub 部署（前台）
⑤ 设置主密钥（前台）
⑥ 初始化建表（D1 控制台逐条 SQL）
⑦ 首次使用
```

---

## ① 创建 D1 数据库（前台）

1. 打开 https://dash.cloudflare.com 登录
2. 左侧菜单 **Workers 和 Pages** → 顶部点 **D1** 标签
3. 点 **创建数据库（Create database）**
4. 名称填 `cdt-monitor-db` → **创建**
5. 进入详情页，复制 **Database ID**（一串 UUID），备用

---

## ② 创建 KV 命名空间（前台）

1. 左侧 **Workers 和 Pages** → 顶部点 **KV** 标签
2. 点 **创建命名空间（Create a namespace）**
3. 名称填 `CACHE` → **添加**
4. 复制该命名空间的 **ID**，备用

---

## ③ 回填 ID 到 GitHub 仓库（关键一步）

`wrangler.toml` 里有两处占位符 `REPLACE_WITH_DATABASE_ID` 和 `REPLACE_WITH_KV_ID`，需要替换成 ① ② 的真实 ID。

**方式 A（让 AI 帮你改）**：把这两个 ID 发给你的 AI 助手，让它改好并提交到仓库。

**方式 B（自己在 GitHub 网页改）**：
1. 打开 https://github.com/muzhi621/cdt-worker/blob/main/wrangler.toml
2. 点右上角铅笔图标 ✏️ 编辑
3. 把 `database_id = "REPLACE_WITH_DATABASE_ID"` 改成 `database_id = "你的D1真实ID"`
4. 把 `id = "REPLACE_WITH_KV_ID"` 改成 `id = "你的KV真实ID"`
5. 底部点 **Commit changes** 提交

---

## ④ 连接 GitHub 部署（前台，核心步骤）

1. 左侧菜单 **Workers 和 Pages** → 点 **创建（Create）**
2. 选择 **Pages** 标签 → 点 **连接到 Git（Connect to Git）**
   - 或者选择 **Workers** → **使用 GitHub 创建 Worker**
3. 首次会弹出 **GitHub 授权**，点 **授权 Cloudflare**，选择要授权的仓库 `cdt-worker`
4. 授权后回到 Cloudflare，选择仓库 `muzhi621/cdt-worker`
5. 开始设置：
   - **项目名称**：`cdt-monitor`（或默认）
   - **生产分支**：`main`
   - **构建命令**：留空（Cloudflare 会自动识别 Worker 项目，无需手动构建命令）
   - **框架预设**：选择 **无/None** 或 **Workers**
6. 点 **保存并部署（Save and Deploy）**

Cloudflare 会开始构建。构建完成后，会显示一个部署地址：
`https://cdt-monitor.<你的子域>.workers.dev`

> 如果 Cloudflare 提示需要选择「框架预设」，选 **Workers**；
> 构建命令和输出目录都留空即可，wrangler.toml 已包含所有配置。

---

## ⑤ 设置主密钥（前台）

1. 在 Worker 详情页 → **设置（Settings）** → **变量和机密（Variables and Secrets）**
2. 找到 **机密（Secrets）** 区域 → **添加**
3. 名称填 `CDT_MASTER_KEY`
4. 值填一个 32 字节的 base64 字符串，例如（**建议自己重新生成**）：
   ```
   e7vX2kQp9zWm4nB8cD1fGhJ3kL5pO6rS0tYuIwAaQsDe
   ```
5. **先复制保存这个密钥**（丢失后无法解密已存的阿里云凭据）
6. 保存，并**重新部署一次**让 Secret 生效（点「部署」或推一次代码）

---

## ⑥ 初始化数据库表结构（D1 控制台逐条执行）

1. 左侧 **Workers 和 Pages** → **D1** → 进入 `cdt-monitor-db`
2. 点 **控制台（Console）** 标签
3. 打开仓库里的 `schema.sql`，把里面的 `CREATE TABLE` 语句**逐条**粘贴到控制台执行（约 10 条）

   > 也可以一次性把整个 schema.sql 内容粘贴进去执行（D1 控制台支持多语句）。

---

## ⑦ 首次使用

1. 打开部署地址（第 ④ 步生成的 `*.workers.dev` 链接）
2. 进入**首次安装向导**，设置管理员密码（至少 10 位）
3. 登录后 → 「账号」页添加阿里云 AK/Secret（自动加密存 D1）
4. 「设置」页配置阈值、停机模式
5. 系统按 Cron 每 5 分钟自动监控

---

## 验证

- 访问 `https://你的地址/healthz` → `{"status":"ok"}`
- 访问 `https://你的地址/readyz` → `{"status":"ready"}`
- Worker 详情页 → **日志（Logs）** 看 Cron 监控日志

---

## Cron 触发器说明

`wrangler.toml` 里已配置 `*/5 * * * *`（每 5 分钟监控一次）。
通过 GitHub 集成部署时，Cron 配置会从 wrangler.toml 自动读取，无需手动设置。

---

## 常见问题

### Q1：GitHub 授权找不到仓库

授权时勾选「所有仓库」或手动把 `cdt-worker` 加入授权范围，然后刷新。

### Q2：构建失败

- 检查 ③ 是否已把真实 ID 填入 wrangler.toml
- 在部署详情页看构建日志（Deployment → 查看日志）

### Q3：改代码后如何更新

直接 push 到 `main` 分支，Cloudflare 会自动重新构建部署（Git 集成默认自动部署）。

### Q4：Secret 改了不生效

Cloudflare 的 Secret 修改后需要**触发一次重新部署**才会生效，手动点一下「重新部署」即可。

---

## 关键点总结

| 步骤 | 操作位置 | 纯前台？ |
| --- | --- | --- |
| 创建 D1 | D1 标签页 | ✅ |
| 创建 KV | KV 标签页 | ✅ |
| 回填 ID | GitHub 网页编辑 wrangler.toml | ✅ |
| 连接部署 | Pages/Git 集成 | ✅ |
| 主密钥 | Worker 设置 → Secrets | ✅ |
| 建表 | D1 控制台 | ✅ |
| Cron | 自动读取 wrangler.toml | ✅ |

**全部步骤都可纯前台完成**，唯一需要你提供的就是 D1 和 KV 的两个 ID。
