// 引擎层：监控循环 + 策略引擎
// 对应原 Go 项目 internal/engine/engine.go
// 纯函数策略 + 阿里云调用 + 幂等 + 通知 Outbox

import type { Account } from '../provider/aliyun';
import * as aliyun from '../provider/aliyun';
import * as store from '../store/store';
import { deliverEvent, hasActiveChannel, type NotificationEvent, type NotifyConfig } from '../notify/service';
import { newToken, type Env } from '../security/security';

// 状态常量（与原 Go 项目一致）
const StatusStarting = 'Starting';
const StatusStopping = 'Stopping';
const StatusStopped = 'Stopped';
const StatusRunning = 'Running';
const StatusUnknown = 'Unknown';

// 定时开关机命中窗口（2 小时）：容忍外部 cron 延迟，幂等键保证一天只执行一次
const SCHEDULE_WINDOW_MS = 2 * 60 * 60 * 1000;

function masked(accessKeyId: string): string {
  return accessKeyId.length <= 7 ? accessKeyId + '***' : accessKeyId.slice(0, 7) + '***';
}

// 把 Date 转换到配置时区，返回一个"墙钟数值等于目标时区本地时间"的 Date。
// Worker 运行时是 UTC，原项目用 time.LoadLocation(config.Timezone) 计算本地时间；
// 供 dueWithin（定时开关机）使用。整点/保活时段/账单月份用 zoneFields 直接取字段。
function toZone(date: Date, timezone: string): Date {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'Asia/Shanghai',
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date);
    const g: Record<string, number> = {};
    for (const p of parts) if (p.type !== 'literal') g[p.type] = parseInt(p.value, 10);
    const asUTC = Date.UTC(g.year, (g.month || 1) - 1, g.day, g.hour, g.minute, g.second);
    return new Date(asUTC);
  } catch {
    return date; // 时区非法时回退到 UTC（与原项目 FixedZone CST 回退语义等价，均保证不崩溃）
  }
}

// 以目标时区的“墙钟字符串”形式获取当前时间字段（YYYY-MM-DD HH:mm:ss）
function zoneFields(date: Date, timezone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'Asia/Shanghai', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date);
    const g: Record<string, number> = {};
    for (const p of parts) if (p.type !== 'literal') g[p.type] = parseInt(p.value, 10);
    return { year: g.year, month: g.month || 1, day: g.day, hour: g.hour || 0, minute: g.minute || 0, second: g.second || 0 };
  } catch {
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
  }
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

// 地域 ID → 中文名（用于通知变量「地区」）
const REGION_NAMES: Record<string, string> = {
  'cn-hangzhou': '华东1（杭州）', 'cn-shanghai': '华东2（上海）', 'cn-beijing': '华北2（北京）',
  'cn-shenzhen': '华南1（深圳）', 'cn-qingdao': '华北1（青岛）', 'cn-zhangjiakou': '华北3（张家口）',
  'cn-huhehaote': '华北5（呼和浩特）', 'cn-wulanchabu': '华北6（乌兰察布）', 'cn-chengdu': '西南1（成都）',
  'cn-hongkong': '中国香港', 'ap-southeast-1': '新加坡', 'ap-southeast-2': '澳大利亚（悉尼）',
  'ap-southeast-3': '马来西亚（吉隆坡）', 'ap-southeast-5': '印度尼西亚（雅加达）', 'ap-northeast-1': '日本（东京）',
  'ap-northeast-2': '韩国（首尔）', 'ap-south-1': '印度（孟买）', 'us-west-1': '美国（硅谷）',
  'us-east-1': '美国（弗吉尼亚）', 'eu-west-1': '英国（伦敦）', 'eu-central-1': '德国（法兰克福）',
  'me-east-1': '阿联酋（迪拜）',
};

// 构造通知变量上下文：账号/地域/实例/时间/流量/金额等，供自定义模板渲染
function accountVars(
  account: Account,
  config: store.Config,
  ctx: { traffic: number; status: string; percentage: number; now: Date; timezone: string; balance: string; cost: string },
): Record<string, string> {
  const remaining = Math.max(0, account.maxTraffic - ctx.traffic);
  const fmtTime = (d: Date, tz: string) => {
    try {
      return d.toLocaleString('zh-CN', { timeZone: tz || 'Asia/Shanghai' });
    } catch { return d.toISOString(); }
  };
  return {
    '账号': masked(account.accessKeyId),
    '机器名': account.remark || account.name || '',
    '备注': account.remark || '',
    '地区': REGION_NAMES[account.regionId] || account.regionId || '',
    '地域ID': account.regionId || '',
    '实例': account.instanceId || '',
    '停机模式': config.shutdownMode === 'StopCharging' ? '节省停机' : '普通停机',
    '开机时间': account.scheduleEnabled ? (account.startTime || '08:00') : '未启用',
    '关机时间': account.scheduleEnabled ? (account.stopTime || '23:00') : '未启用',
    '已用流量': `${ctx.traffic.toFixed(2)} GB`,
    '流量上限': `${account.maxTraffic.toFixed(2)} GB`,
    '剩余流量': `${remaining.toFixed(2)} GB`,
    '使用率': `${ctx.percentage.toFixed(2)}%`,
    '阈值': `${config.trafficThreshold}%`,
    '实例状态': ctx.status,
    '账户余额': ctx.balance,
    '使用金额': ctx.cost,
    '时间': fmtTime(ctx.now, ctx.timezone),
    '时区': ctx.timezone || 'Asia/Shanghai',
  };
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
// preloadedConfig：批量监控时复用已读取的配置，避免每个账号重复读 D1 + 解密
export async function processAccount(
  env: Env,
  account: Account,
  force = false,
  preloadedConfig?: store.Config,
): Promise<MonitorResult> {
  const config = preloadedConfig ?? await store.getConfig(env);
  const actions: string[] = [];
  let statusChangedBySchedule = false;
  const now = new Date();
  // 配置时区的“墙钟”时间（对齐原项目 time.Now().In(config.Timezone)）
  const local = toZone(now, config.timezone);
  const localFields = zoneFields(now, config.timezone);

  // 定时开关机
  // 命中窗口放宽到 2 小时：外部 cron（GitHub Actions 等）常有数分钟到数十分钟延迟，
  // 窗口过窄会整天错过；action_events 幂等键（含日期）保证同一天只执行一次
  if (account.scheduleEnabled) {
    if (dueWithin(local, account.startTime, SCHEDULE_WINDOW_MS)) {
      const changed = await executeScheduledAction(env, config, account, 'start', now);
      if (changed) {
        actions.push('scheduled_start');
        account.instanceStatus = StatusStarting;
        statusChangedBySchedule = true;
      }
    }
    if (dueWithin(local, account.stopTime, SCHEDULE_WINDOW_MS)) {
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
  const due = force || updatedAt === 0 || Date.now() - updatedAt >= interval || localFields.minute === 0 || statusChangedBySchedule;

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
  // 读取账单缓存（余额/月度金额），供通知变量使用（未开启账单功能时为空）
  let balanceText = '';
  let costText = '';
  if (config.enableBilling) {
    try {
      const bal = await store.billingCache<{ amount: number; currency: string }>(env, account.id, 'balance', '', 6);
      if (bal.hit && bal.value) balanceText = `${bal.value.amount} ${bal.value.currency || ''}`.trim();
      const bill = await store.billingCache<{ totalCost: number }>(env, account.id, 'instance_bill', now.toISOString().slice(0, 7), 6);
      if (bill.hit && bill.value) costText = `${bill.value.totalCost}`;
    } catch { /* 账单读取失败不影响通知 */ }
  }
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
      const vars = accountVars(account, config, {
        traffic, status, percentage, now,
        timezone: config.timezone,
        balance: balanceText, cost: costText,
      });
      const event = newEvent('threshold', '流量阈值告警', `账号 ${masked(account.accessKeyId)} 的流量使用率达到 ${percentage.toFixed(2)}%。`, account.id, {
        ...vars,
        '当前流量': `${traffic.toFixed(2)} GB`,
        '设定阈值': `${config.trafficThreshold}%`,
      });
      await store.addOutbox(env, 'notify', event);
      await store.addLog(env, 'warning', event.summary);
    }
  }

  // 保活
  const hhmm = `${String(localFields.hour).padStart(2, '0')}:${String(localFields.minute).padStart(2, '0')}`;
  if (config.keepAlive && !overThreshold && !statusChangedBySchedule && status === StatusStopped &&
      (!account.scheduleEnabled || inTimeRange(hhmm, account.startTime, account.stopTime))) {
    const key = `keepalive:${account.id}:${localFields.year}${String(localFields.month).padStart(2, '0')}${String(localFields.day).padStart(2, '0')}${String(localFields.hour).padStart(2, '0')}${String(localFields.minute).padStart(2, '0')}`;
    const fresh = await store.recordActionEvent(env, key, account.id, 'keepalive', 'attempting', '');
    if (fresh) {
      try {
        await aliyun.controlInstance(account, account.accessKeySecret, 'start', config.shutdownMode);
        status = StatusStarting;
        await store.updateRuntime(env, account.id, traffic, status, new Date().toISOString());
        actions.push('keepalive_start');
        const event = newEvent('keepalive', '实例保活启动', '检测到实例在允许运行时段意外停止，已发送启动指令。', account.id, {
          ...accountVars(account, config, {
            traffic, status, percentage, now,
            timezone: config.timezone, balance: balanceText, cost: costText,
          }),
        });
        await store.addOutbox(env, 'notify', event);
      } catch (err) {
        await store.deleteActionEvent(env, key);
        await store.addLog(env, 'error', `保活启动失败 [${masked(account.accessKeyId)}]: ${err}`);
      }
    }
  }

  // 账单
  if (config.enableBilling) {
    const balanceCache = await store.billingCache(env, account.id, 'balance', '', 6);
    if (force || localFields.hour % 6 === 0 || !balanceCache.hit) {
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
  // key 对齐原项目 scheduleActionKey：schedule:{id}:{YYYYMMDD}:{action}:{HH:mm}
  const f = zoneFields(now, config.timezone);
  const dateStr = `${f.year}${String(f.month).padStart(2, '0')}${String(f.day).padStart(2, '0')}`;
  const timeStr = `${String(f.hour).padStart(2, '0')}:${String(f.minute).padStart(2, '0')}`;
  const key = `schedule:${account.id}:${dateStr}:${action}:${timeStr}`;
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
      ...accountVars(account, config, {
        traffic: account.trafficUsed, status, percentage: usagePercent(account.trafficUsed, account.maxTraffic), now,
        timezone: config.timezone, balance: '', cost: '',
      }),
    });
    await store.addOutbox(env, 'notify', event);
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

// 消费通知队列：把 outbox 中待发事件发往所有已配置通道
// 全部通道成功 → sent；任一失败 → 5 分钟后重试，入队超 24 小时仍失败则放弃
// 每次监控周期末尾调用一次（外部触发即消费节奏）
export async function flushOutbox(env: Env, config: store.Config): Promise<void> {
  if (!hasActiveChannel(config.notifications as unknown as NotifyConfig)) return;
  let rows;
  try {
    rows = await store.listPendingOutbox(env, 10);
  } catch {
    return;
  }
  for (const row of rows) {
    let event: NotificationEvent;
    try {
      event = JSON.parse(row.payload) as NotificationEvent;
    } catch {
      await store.markOutboxSent(env, row.id); // 无法解析的脏数据直接丢弃
      continue;
    }
    const results = await deliverEvent(config.notifications as unknown as NotifyConfig, event);
    const failures = results.filter((r) => !r.ok);
    if (failures.length === 0) {
      await store.markOutboxSent(env, row.id);
      continue;
    }
    const detail = failures.map((f) => `${f.channel}: ${f.error}`).join('; ');
    const outcome = await store.markOutboxRetry(env, row.id, detail, 300, 24 * 3600);
    if (outcome === 'failed') {
      await store.addLog(env, 'error', `通知发送失败已放弃(#{${row.id}}): ${detail}`);
    } else {
      await store.addLog(env, 'warning', `通知部分通道发送失败，5 分钟后重试: ${detail}`);
    }
  }
}
