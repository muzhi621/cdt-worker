# 外部定时服务配置教程（监控触发器）

> CDT-Monitor Worker 版使用「外部 HTTP 触发」实现定时监控，不占用 Cloudflare 的 Cron 免费额度（仅 5 个）。
> 原理：外部定时服务每隔 N 分钟请求一次你的 Worker 的 `/__cron` 接口，触发一轮监控。

---

## 为什么不用 Cloudflare 自带 Cron？

Cloudflare 免费版每个账号只有 **5 个 Cron 触发器**额度，容易用完（会报 `10072` 错误）。
改用外部定时服务请求 `/__cron`，完全绕开这个限制，且免费、可靠。

---

## 方案一：cron-job.org（推荐，最省事）

cron-job.org 是免费的外部定时服务，无需信用卡，适合个人项目。

### 步骤

1. 打开 https://cron-job.org ，点 **Sign up** 注册（用邮箱即可）
2. 登录后，点左侧 **Cronjobs** → 右上角 **Create cronjob**
3. 填写配置：

   | 字段 | 填什么 |
   | --- | --- |
   | **Title** | `cdt-monitor`（随意命名） |
   | **URL** | `https://cdt-worker.muzhi.workers.dev/__cron`（替换成你的 Worker 地址） |
   | **Execution schedule** | 选 **Every 5 minutes**（与前台「监控间隔」保持一致） |

4. 往下滚动，其它保持默认（请求方式 GET）
5. 点 **Create** 保存

完成！之后 cron-job.org 会每 5 分钟请求一次你的 Worker，自动触发监控。

### 注意事项

- cron-job.org 免费版：任务间隔最低可到 1 分钟，足够使用
- 如果长时间不用，cron-job.org 可能暂停任务，记得偶尔登录看一眼
- URL 里的 `muzhi.workers.dev` 换成你自己的 Worker 域名

---

## 方案二：GitHub Actions（如果你已有 GitHub 账号）

无需额外注册，用 GitHub 仓库的定时 workflow 触发。

1. 在你的 GitHub 仓库（`muzhi621/cdt-worker`）里新建文件 `.github/workflows/cron.yml`：

   ```yaml
   name: cdt-monitor-trigger
   on:
     schedule:
       - cron: '*/5 * * * *'   # 每 5 分钟
     workflow_dispatch: {}      # 允许手动触发
   jobs:
     trigger:
       runs-on: ubuntu-latest
       steps:
         - name: Trigger monitor
           run: |
             curl -s "https://cdt-worker.muzhi.workers.dev/__cron"
   ```

2. 提交推送后，GitHub 会每 5 分钟自动运行一次，请求你的 `/__cron`

> 注意：GitHub Actions 的 cron 在负载高时可能有几分钟延迟，但用于流量监控完全够用。

---

## 方案三：其它免费 cron 服务（备选）

| 服务 | 免费额度 | 特点 |
| --- | --- | --- |
| cron-job.org | 无限任务，最低 1 分钟 | 推荐，最常用 |
| UptimeRobot | 免费 50 个监控，最低 5 分钟 | 还能顺带做健康监控 |
| Better Stack | 免费 10 个监控 | 有可视化面板 |
| Freshping | 免费 50 个 | 简单 |

这些服务都是「定时 GET 一个 URL」的模式，把 URL 指向你的 `/__cron` 即可。

---

## 关键：监控间隔如何配合

- **前台设置里的「监控间隔（分钟）」** 是 Worker 内部的**防抖阈值**
- **外部定时服务的调度频率** 是实际触发频率
- 两者**保持一致**即可；如果外部触发频率 < 前台间隔，Worker 会自动跳过（防抖），不会重复执行

例如：
- 前台设「5 分钟」，cron-job.org 也设每 5 分钟 → 每 5 分钟监控一次 ✅
- 前台设「5 分钟」，cron-job.org 设每 1 分钟 → 仍然每 5 分钟才真正执行（防抖） ✅

---

## 验证是否生效

1. 手动在浏览器访问一次 `https://你的地址/__cron`，应返回：
   ```json
   {"monitored": N, "interval_minutes": 5}
   ```
   （N 是你的账号数；若返回 `skipped: true` 说明刚运行过、被防抖跳过了）

2. 回到管理台「日志」页，能看到 `heartbeat` 类型的监控日志，说明监控在正常工作

---

## 常见问题

### Q1：/__cron 返回 500 或报错？

- 检查 `CDT_MASTER_KEY` 是否已设置（43 位 base64）
- 检查是否已添加阿里云账号（没账号时返回 `monitored: 0` 是正常的）

### Q2：外部服务请求了，但没看到监控日志？

- 可能是被防抖跳过了（间隔内重复触发），属正常现象
- 确认前台「监控间隔」和外部的调度频率一致

### Q3：想临时手动触发一次监控？

直接在浏览器访问 `https://你的地址/__cron` 即可（无需登录）。
