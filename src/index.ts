// Worker 入口（仅 HTTP 触发 —— 原生 Cron Trigger 已移除）
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
};
