// 引擎层：监控循环 + 策略引擎
// 对应原 Go 项目 internal/engine/engine.go
// 纯函数策略 + 阿里云调用 + 幂等 + 通知 Outbox

import type { Account } from '../provider/aliyun';
import * as aliyun from '../provider/aliyun';
import * as store from '../store/store';
import { enabledChannels, type NotificationEvent, type NotifyConfig } from '../notify/service';
import { newToken, type Env } from '../security/security';

// 状态常量（与原 Go 项目一致）
const StatusStarting = 'Starting';
const StatusStopping = 'Stopping';
const StatusStopped = 'Stopped';
const StatusRunning = 'Running';
const StatusUnknown = 'Unknown';

function masked(accessKeyId: string): string {
  return accessKeyId.length <= 7 ? accessKeyId + '***' : accessKeyId.slice(0, 7) + '***';
}

function usagePercent(traffic: number, maxTraffic: number): number {
  if (maxTraffic <= 0) return 0;
  return Math.round((traffic / maxTraffic) * 10000) / 100;
}

function transient(status: string): boolean {
  return status === StatusStarting || status === StatusStopping || status === 'Pending' || status === StatusUnknown;
}

function dueWithin(now: Date, hhmm: string, windowMs: number): boolean {
  if (!hhmm) return false;
  const [h, m] = hhmm.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return false;
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  const delta = now.getTime() - target.getTime();
  return delta >= 0 && delta <= windowMs;
}

function inTimeRange(current: string, start: string, end: string): boolean {
  if (!start || !end) return false;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

function newEvent(
  eventType: string,
  title: string,
  summary: string,
  accountId: number,
  fields: Record<string, string>,
): NotificationEvent {
  return { id: newToken(18), type: eventType, title, summary, accountId, fields, createdAt: new Date().toISOString() };
}

export interface MonitorResult {
  accountId: number;
  message: string;
  actions: string[];
}

// 处理单个账号的监控，等价 processAccount()
export async function processAccount(env: Env, account: Account, force = false): Promise<MonitorResult> {
  const config = await store.getConfig(env);
  const actions: string[] = [];
  let statusChangedBySchedule = false;
  const now = new Date();

  // 定时开关机
  if (account.scheduleEnabled) {
    if (dueWithin(now, account.startTime, 10 * 60 * 1000)) {
      const changed = await executeScheduledAction(env, config, account, 'start', now);
      if (changed) {
        actions.push('scheduled_start');
        account.instanceStatus = StatusStarting;
        statusChangedBySchedule = true;
      }
    }
    if (dueWithin(now, account.stopTime, 10 * 60 * 1000)) {
      const changed = await executeScheduledAction(env, config, account, 'stop', now);
      if (changed) {
        actions.push('scheduled_stop');
        account.instanceStatus = StatusStopping;
        statusChangedBySchedule = true;
      }
    }
  }

  // 刷新频率判断
  let interval = config.apiInterval * 1000;
  if (transient(account.instanceStatus)) interval = 60 * 1000;
  const updatedAt = account.updatedAt ? new Date(account.updatedAt).getTime() : 0;
  const due = force || updatedAt === 0 || Date.now() - updatedAt >= interval || now.getMinutes() === 0 || statusChangedBySchedule;

  let traffic = account.trafficUsed;
  let status = account.instanceStatus;
  if (due) {
    const [trafficResult, statusResult] = await Promise.allSettled([
      aliyun.getTraffic(account, account.accessKeySecret),
      aliyun.getInstanceStatus(account, account.accessKeySecret),
    ]);
    if (trafficResult.status === 'fulfilled') {
      traffic = trafficResult.value;
    } else {
      await store.addLog(env, 'error', `流量查询失败 [${masked(account.accessKeyId)}]: ${trafficResult.reason}`);
    }
    if (statusResult.status === 'fulfilled' && statusResult.value) {
      status = statusResult.value;
    } else {
      await store.addLog(env, 'error', `实例状态查询失败 [${masked(account.accessKeyId)}]: ${statusResult.status === 'rejected' ? statusResult.reason : ''}`);
    }
    if (statusChangedBySchedule) {
      if (actions.includes('scheduled_start')) status = StatusStarting;
      else if (actions.includes('scheduled_stop')) status = StatusStopping;
    }
    await store.updateRuntime(env, account.id, traffic, status, new Date().toISOString());
    if (trafficResult.status === 'fulfilled') {
      await store.addTrafficStat(env, account.id, traffic, now.toISOString());
    }
  }

  // 阈值判断
  const percentage = usagePercent(traffic, account.maxTraffic);
  const overThreshold = percentage >= config.trafficThreshold;
  const thresholdKey = `threshold:${account.id}:active`;
  if (!overThreshold) {
    await store.deleteActionEvent(env, thresholdKey);
  }
  if (overThreshold && due) {
    const recorded = await store.recordActionEvent(env, thresholdKey, account.id, 'threshold', 'detected', `${percentage.toFixed(2)}%`);
    if (recorded) {
      if (config.thresholdAction === 'stop_and_notify' && status !== StatusStopped && status !== StatusStopping) {
        try {
          await aliyun.controlInstance(account, account.accessKeySecret, 'stop', config.shutdownMode);
          status = StatusStopping;
          await store.updateRuntime(env, account.id, traffic, status, new Date().toISOString());
          actions.push('threshold_stop');
        } catch (err) {
          await store.deleteActionEvent(env, thresholdKey);
          await store.addLog(env, 'error', `阈值停机失败 [${masked(account.accessKeyId)}]: ${err}`);
        }
      }
      const event = newEvent('threshold', '流量阈值告警', `账号 ${masked(account.accessKeyId)} 的流量使用率达到 ${percentage.toFixed(2)}%。`, account.id, {
        '当前流量': `${traffic.toFixed(2)} GB`,
        '设定阈值': `${config.trafficThreshold}%`,
        '实例状态': status,
      });
      await store.addOutbox(env, 'telegram', event);
      await store.addOutbox(env, 'webhook', event);
      await store.addOutbox(env, 'email', event);
      await store.addLog(env, 'warning', event.summary);
    }
  }

  // 保活
  if (config.keepAlive && !overThreshold && !statusChangedBySchedule && status === StatusStopped &&
      (!account.scheduleEnabled || inTimeRange(now.toTimeString().slice(0, 5), account.startTime, account.stopTime))) {
    const key = `keepalive:${account.id}:${now.toISOString().slice(0, 16)}`;
    const fresh = await store.recordActionEvent(env, key, account.id, 'keepalive', 'attempting', '');
    if (fresh) {
      try {
        await aliyun.controlInstance(account, account.accessKeySecret, 'start', config.shutdownMode);
        status = StatusStarting;
        await store.updateRuntime(env, account.id, traffic, status, new Date().toISOString());
        actions.push('keepalive_start');
        const event = newEvent('keepalive', '实例保活启动', '检测到实例在允许运行时段意外停止，已发送启动指令。', account.id, {
          '账号': masked(account.accessKeyId),
          '实例': account.instanceId,
        });
        await store.addOutbox(env, 'telegram', event);
        await store.addOutbox(env, 'webhook', event);
        await store.addOutbox(env, 'email', event);
      } catch (err) {
        await store.deleteActionEvent(env, key);
        await store.addLog(env, 'error', `保活启动失败 [${masked(account.accessKeyId)}]: ${err}`);
      }
    }
  }

  // 账单
  if (config.enableBilling) {
    const balanceCache = await store.billingCache(env, account.id, 'balance', '', 6);
    if (force || now.getHours() % 6 === 0 || !balanceCache.hit) {
      try {
        const balance = await aliyun.getAccountBalance(account, account.accessKeySecret);
        await store.setBillingCache(env, account.id, 'balance', '', balance);
      } catch (err) {
        await store.addLog(env, 'error', `账单查询失败 [${masked(account.accessKeyId)}]: ${err}`);
      }
    }
  }

  let message = `[${masked(account.accessKeyId)}] 流量 ${traffic.toFixed(2)}GB / ${account.maxTraffic.toFixed(2)}GB (${percentage.toFixed(2)}%) · 状态 ${status}`;
  if (actions.length > 0) message += ' · 动作 ' + actions.join(',');
  await store.addLog(env, 'heartbeat', message);
  return { accountId: account.id, message, actions };
}

async function executeScheduledAction(
  env: Env,
  config: store.Config,
  account: Account,
  action: 'start' | 'stop',
  now: Date,
): Promise<boolean> {
  const key = `schedule:${account.id}:${now.toISOString().slice(0, 10)}:${action}`;
  const fresh = await store.recordActionEvent(env, key, account.id, 'schedule_' + action, 'attempting', '');
  if (!fresh) return false;
  try {
    await aliyun.controlInstance(account, account.accessKeySecret, action, config.shutdownMode);
  } catch (err) {
    await store.deleteActionEvent(env, key);
    await store.addLog(env, 'error', `定时${action === 'start' ? '开机' : '关机'}失败 [${masked(account.accessKeyId)}]: ${err}`);
    return false;
  }
  const status = action === 'start' ? StatusStarting : StatusStopping;
  await store.updateRuntime(env, account.id, account.trafficUsed, status, new Date().toISOString());
  await store.addLog(env, 'info', `执行定时${action === 'start' ? '开机' : '关机'} [${masked(account.accessKeyId)}]`);
  if (config.enableScheduleMail) {
    const event = newEvent('schedule', '定时任务已执行', `实例定时${action === 'start' ? '开机' : '关机'}指令已发送。`, account.id, {
      '账号': masked(account.accessKeyId),
      '实例': account.instanceId,
    });
    await store.addOutbox(env, 'telegram', event);
    await store.addOutbox(env, 'webhook', event);
    await store.addOutbox(env, 'email', event);
  }
  return true;
}

// 手动控制，等价 control()
export async function control(
  env: Env,
  accountId: number,
  action: 'start' | 'stop',
  source: string,
): Promise<string> {
  const config = await store.getConfig(env);
  const account = config.accounts.find((a) => a.id === accountId);
  if (!account) throw new Error('account not found');
  if (action !== 'start' && action !== 'stop') throw new Error('action must be start or stop');
  if (transient(account.instanceStatus)) throw new Error(`instance is currently ${account.instanceStatus}`);
  if (config.keepAlive && action === 'stop') throw new Error('manual shutdown is disabled while keep-alive is enabled');
  await aliyun.controlInstance(account, account.accessKeySecret, action, config.shutdownMode);
  const status = action === 'start' ? StatusStarting : StatusStopping;
  await store.updateRuntime(env, account.id, account.trafficUsed, status, new Date().toISOString());
  const message = `${source}控制实例 [${masked(account.accessKeyId)}]：${action}`;
  await store.addLog(env, 'audit', message);
  return message;
}

// 汇总状态，等价 Summary()
export async function summary(env: Env) {
  const config = await store.getConfig(env);
  const result = config.accounts.map((account) => {
    const percentage = usagePercent(account.trafficUsed, account.maxTraffic);
    return {
      id: account.id,
      name: account.remark || masked(account.accessKeyId),
      account: masked(account.accessKeyId),
      status: account.instanceStatus,
      used: Math.round(account.trafficUsed * 100) / 100,
      total: account.maxTraffic,
      percentage,
      threshold: config.trafficThreshold,
      overThreshold: percentage >= config.trafficThreshold,
      updatedAt: account.updatedAt,
    };
  });
  return result;
}
