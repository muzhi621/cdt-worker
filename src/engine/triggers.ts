// 触发源（监控调度渠道）：开关解析、来源识别、断档判定
// 背景：外部触发源（GitHub Actions 的 schedule 等）存在延迟/丢跑/被自动禁用的情况，
// 一旦断档，实例会错过整天的开关机窗口持续产生费用却无人察觉。
// 因此每个渠道独立开关 + 记录「上次触发时间」+ 断档告警。

// Cloudflare 原生 Cron Trigger：wrangler.toml 的 [triggers] crons 固定每 5 分钟触发
// scheduled()（CF 的 cron 表达式无法运行时修改，改一次要重新部署）。
// 「实际多久跑一次」由管理台的「监控间隔」控制：CF 每 5 分钟叫一次，不足间隔的轮次
// 在 scheduled() 内部直接跳过，不跑阿里云 API、也不写 trigger_seen（保持"上次真实执行"
// 语义，否则断档告警会被自己刷新的时间戳掩盖）。
export type TriggerSource = 'github' | 'http' | 'selfhost' | 'native' | 'tencent' | 'aliyun' | 'huawei';

export const TRIGGER_SOURCES: TriggerSource[] = ['github', 'http', 'selfhost', 'native', 'tencent', 'aliyun', 'huawei'];

export const TRIGGER_LABELS: Record<TriggerSource, string> = {
  github: 'GitHub Actions',
  http: '外部定时服务（cron-job.org 等）',
  selfhost: '自建驱动（self-hosted）',
  native: 'Cloudflare 原生 Cron',
  tencent: '腾讯云云函数 SCF',
  aliyun: '阿里云函数计算 FC',
  huawei: '华为云函数 FG',
};

// 默认开关：CF 原生 Cron 默认开（调度最稳，不依赖任何外部服务）；
// 自建驱动默认开；GitHub Actions 与外部定时默认关——避免同一 5 分钟窗口内
// 多来源重复触发，也免得 GitHub 因长期不活跃自动禁用 schedule 后无人察觉。
export const DEFAULT_TRIGGER_SOURCES: Record<TriggerSource, boolean> = {
  github: false,
  http: false,
  selfhost: true,
  native: true,
  tencent: false,
  aliyun: false,
  huawei: false,
};

// 断档判定阈值（秒）：已启用的渠道超过该时长没有触发即告警（默认 30 分钟）
export const TRIGGER_GAP_THRESHOLD_SEC = 30 * 60;

// 来源识别：外部服务可通过 ?source=xxx 或 X-Trigger-Source: xxx 声明身份。
// 未声明时归为 http（兼容 cron-job.org、自架 curl cron 等既有配置）。
export function normalizeSource(raw: string | null | undefined): TriggerSource {
  const v = (raw || '').trim().toLowerCase();
  if (v === 'github' || v === 'github_actions' || v === 'actions') return 'github';
  if (v === 'selfhost' || v === 'self-host' || v === 'self_host' || v === 'driver') return 'selfhost';
  if (v === 'native' || v === 'cron' || v === 'scheduled') return 'native';
  if (v === 'tencent' || v === 'scf' || v === 'tencent_cloud' || v === 'tencentcloud') return 'tencent';
  if (v === 'aliyun' || v === 'fc' || v === 'alicloud' || v === 'aliyun_fc') return 'aliyun';
  if (v === 'huawei' || v === 'fg' || v === 'huaweicloud' || v === 'functiongraph' || v === 'huawei_fg') return 'huawei';
  return 'http';
}

export function parseTriggerSources(raw: string | null | undefined): Record<TriggerSource, boolean> {
  const out = { ...DEFAULT_TRIGGER_SOURCES };
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const s of TRIGGER_SOURCES) {
      if (typeof parsed[s] === 'boolean') out[s] = parsed[s] as boolean;
    }
  } catch { /* 数据损坏时回退默认，保证不崩溃 */ }
  return out;
}

export function parseTriggerSeen(raw: string | null | undefined): Partial<Record<TriggerSource, number>> {
  const out: Partial<Record<TriggerSource, number>> = {};
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const s of TRIGGER_SOURCES) {
      const v = Number(parsed[s]);
      if (Number.isFinite(v) && v > 0) out[s] = Math.floor(v);
    }
  } catch { /* 同上 */ }
  return out;
}

// 原生 Cron 的节流判定（纯函数，便于单测）：
// CF 固定每 5 分钟调用一次 scheduled()，而用户可以在管理台把「监控间隔」设得更长
// （省阿里云 API 调用与 CF 额度）。间隔为 0 或从未跑过 → 直接执行；否则距上次真实执行
// 不足一个间隔就跳过。
// 注意这里用 lastRun（last_monitor_run，真正抢到槽位的时刻）而不是"触发时刻"——
// 调用方据此决定要不要写 trigger_seen：跳过的轮次绝不能写，否则上次触发时间被自己
// 不断刷新，断档告警（阈值 30 分钟）会被永久掩盖，用户以为监控很勤其实在空转。
export function shouldNativeRun(lastRun: number, intervalMinutes: number, nowSec: number): boolean {
  const minGapSec = Math.max(0, intervalMinutes) * 60;
  if (minGapSec <= 0) return true;
  if (lastRun <= 0) return true;
  return nowSec - lastRun >= minGapSec;
}

// 断档判定：渠道已启用、有过触发记录、且距上次触发超过阈值 → true（需要告警）。
// 从未触发过的渠道（lastSeen 为 0/空）不算断档——可能是刚启用，避免误报。
export function isSourceStale(
  enabled: boolean,
  lastSeen: number | undefined,
  nowSec: number,
  thresholdSec = TRIGGER_GAP_THRESHOLD_SEC,
): boolean {
  if (!enabled) return false;
  if (!lastSeen || lastSeen <= 0) return false;
  return nowSec - lastSeen >= thresholdSec;
}
