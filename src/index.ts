// Worker 入口（HTTP 触发 + 原生 Cron 触发）
import { handleRequest, runMonitorCycle, noteTriggerDisabled } from './http/server';
import { ensureSchema } from './store/schema';
import * as store from './store/store';
import { shouldNativeRun } from './engine/triggers';
import type { Env } from './security/security';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // 首次请求自动建表（幂等），失败时返回可读错误而非崩溃
    try {
      await ensureSchema(env);
    } catch (err) {
      return new Response(
        JSON.stringify({ error: { code: 'schema_init_failed', message: '数据库初始化失败：' + (err as Error).message } }),
        { status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' } },
      );
    }
    return handleRequest(env, request);
  },

  // 原生 Cron Trigger 入口：wrangler.toml 的 [triggers] crons = ["*/5 * * * *"] 每 5 分钟调一次。
  // 直调内部监控函数，不经过 HTTP 层 —— 天然可信，无需 CRON_SECRET；
  // 与外部触发共用同一套防抖与原子抢占（并发时只有一轮真正执行）。
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // 与 fetch 入口对齐：ensureSchema 失败时留痕后直接返回（下轮自动重试），而不是抛出。
    // 抛出去 Cloudflare 只会记一条 uncaught exception，业务侧毫无留痕，排查成本极高。
    try {
      await ensureSchema(env);
    } catch (err) {
      await store.addLog(env, 'error',
        'schema 初始化失败，本轮原生 Cron 跳过（下轮自动重试）：' + (err as Error).message).catch(() => {});
      return;
    }
    // 原生 Cron 受「触发源开关」控制：关闭时跳过（每小时留痕一次）
    const state = await store.getTriggerState(env);
    if (!state.sources.native) {
      await noteTriggerDisabled(env, 'native');
      return;
    }
    const nowSec = Math.floor(Date.now() / 1000);
    // 「监控间隔」节流：CF 固定每 5 分钟叫一次，但用户可能设为更长的间隔以省 API 与额度。
    // 不足间隔的轮次直接跳过 —— 关键是不写 trigger_seen，否则上次触发时间被自己刷新，
    // 断档告警（阈值 30 分钟）会被永久掩盖，用户以为监控很勤其实在空转。
    const ms = await store.getMonitorState(env);
    if (!shouldNativeRun(ms.lastRun, ms.intervalMinutes, nowSec)) return;
    // 本轮确实要跑，才记录「原生 Cron 上次触发时间」（供前端展示与断档判定）
    await store.touchTriggerSource(env, 'native', nowSec, state.seen);
    // 把已读到的 monitor state 透传进去，避免 runMonitorCycle 内部重复查询（省 1 subrequest/轮）
    await runMonitorCycle(env, false, state, 'native', false, ms);
  },
};
