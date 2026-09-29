# 第三轮审查整改报告（修复批次 + 报告批次分离提交）

> 审查范围：全库通读级审查后落地的 3 个中低危问题修复。
> 修复批次 = 代码改动（`fix:` 提交）；报告批次 = 本文件（`docs:` 提交）。两者独立提交，便于单独回滚。

## 一、问题清单与修复

| # | 问题 | 位置 | 严重度 | 修复方式 | 是否破坏现有功能 |
|---|------|------|--------|----------|------------------|
| 1 | 内存限流 `rateMap` 在 Cloudflare 多 isolate / 冷启动下失效，认证后高敏端点限流形同虚设 | `src/http/server.ts` `allowRate` / 10 个端点 | 中 | 新增 `rate_buckets` 表（幂等建表）+ `allowRateD1()` 跨 isolate 计数，作为第二道闸；原内存 `allowRate` 保留为快速第一层，阈值/语义不变 | 否 |
| 2 | `install.sh` 用 bash 单引号包裹配置，`q()` 把 `'` 转成 `\'`（bash 单引号内反斜杠是字面量，转义无效），含 `'` 的 URL/密钥被破坏 | `src/engine/selfhost.ts` `q()` | 低 | 新增 `qBash()`（正确转义 `'\''`），仅用于 `install.sh`；`.mjs` 仍用原 `q()`（JS 模板字面量下 `\'` 合法） | 否 |
| 3 | `MAIL FROM/RCPT TO` 直接将管理员配置拼进 SMTP 命令，含 CR/LF 时可被 CRLF 注入 | `src/notify/smtp.ts` `sendSmtpMail` | 低 | 发送前 `assertSafeSmtpAddress()` 校验 `from`/`to` 不含控制字符（`< 0x20`） | 否 |

## 二、问题 1 的免费额度评估（CF 部署硬约束）

- **单次请求 50 subrequest 上限**：`allowRateD1` 单次调用 = 1 读 +（允许时）1 写 = **最多 2 个 subrequest**。
  这些端点（测试通知 / DDNS 连通 / 删账号 / 改密 / 吊销 Key 等）均为**低频人工管理操作**，不在 `/__cron` 监控周期里，
  不会挤占 cron 周期的 50 subrequest 预算。
- **D1 5M 行/天读配额**：管理操作频率极低，增量可忽略。
- **CPU 10ms/请求**：D1 查询为异步 IO，不显著占用 CPU 预算。
- **容错**：`allowRateD1` 在 D1 异常时 fail-open 返回 `true`（与 `recentLoginFailures` 容错一致），
  DB 抖动不会锁死管理员；且 `rate_buckets` 表由 `ensureSchema` 在部署后首次请求幂等创建，无需手动迁移。

## 三、验证

- 类型检查：`tsc --noEmit` → **TSC_OK（0 error）**
- 测试：`vitest run --no-file-parallelism`（规避已知 EPERM flake）→ **15 文件 / 154 用例全绿**
  - `test/audit-fix.test.ts` 的单引号转义断言已同步更新为正确的 bash 转义 `it'\''s-secret`（`qBash` 行为）。

## 四、部署与回滚

- **部署**：代码改动需 `wrangler deploy` 后生效；`rate_buckets` 表在部署后首次请求由 `ensureSchema` 自动建好。
  `git push` 与 `wrangler deploy` 是两步，推送 GitHub ≠ 上线。
- **前端版本**：本次纯后端改动，**未改动** `src/web/index.html`，故**未升** `APP_BUILD`。
- **回滚**：修复批次是独立 commit，可单独 `git revert` 回退而不影响报告批次；反之亦然。
