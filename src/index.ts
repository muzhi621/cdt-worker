// Worker 入口
import { handleRequest } from './http/server';
import type { Env } from './security/security';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(env, request);
  },

  // Cron 触发器：每 5 分钟执行监控循环
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const url = new URL('https://cdt-monitor.internal/__cron');
    await handleRequest(env, new Request(url.toString(), { headers: { 'X-Cron-Trigger': 'true' } }));
  },
};
