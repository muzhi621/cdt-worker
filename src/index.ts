// Worker 入口
import { handleRequest } from './http/server';
import { ensureSchema } from './store/schema';
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

  // 保留 scheduled 入口（可选，用于未来启用 Cron 触发时）
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await ensureSchema(env);
    const url = new URL('https://cdt-monitor.internal/__cron');
    await handleRequest(env, new Request(url.toString(), { headers: { 'X-Cron-Trigger': 'true' } }));
  },
};
