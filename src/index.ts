// Worker 入口
import { handleRequest, runMonitorCycle, noteTriggerDisabled } from './http/server';
import { ensureSchema } from './store/schema';
import * as store from './store/store';
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

  // 原生 Cron Trigger 入口（需 wrangler.toml 的 [triggers] 启用，默认关闭：
  // 免费版账号 5 个 Cron 额度易耗尽，会报 error 10072 导致部署失败）。
  // 直调内部监控函数，不经过 HTTP 层 —— 天然可信，无需 CRON_SECRET，
  // 与外部触发共用同一套防抖与原子抢占（并发时只有一轮真正执行）。
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await ensureSchema(env);
    // 原生 Cron 也受「触发源开关」控制：关闭时跳过（每小时留痕一次），
    // 开启时记录本次触发时间（供前端展示与断档判定），再跑监控。
    const { sources } = await store.getTriggerState(env);
    if (!sources.native) {
      await noteTriggerDisabled(env, 'native');
      return;
    }
    await store.touchTriggerSource(env, 'native', Math.floor(Date.now() / 1000));
    await runMonitorCycle(env);
  },
};
