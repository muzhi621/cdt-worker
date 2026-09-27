// 触发源（监控调度渠道）：开关解析、来源识别、断档判定
// 背景：外部触发源（GitHub Actions 的 schedule 等）存在延迟/丢跑/被自动禁用的情况，
// 一旦断档，实例会错过整天的开关机窗口持续产生费用却无人察觉。
// 因此每个渠道独立开关 + 记录「上次触发时间」+ 断档告警。

// 注意：Cloudflare 原生 Cron Trigger 已彻底移除（含 src/index.ts 的 scheduled() 出口与
// wrangler.toml 的 [triggers]）。原因：免费版 Cron Trigger 额度是【账号级 5 个】，本项目
// 改用外部触发后不需要占用它；且 scheduled 事件会额外消耗 CPU 计费时长。
// 存量数据兼容：老 settings 里可能残留 "native" 键，parseTriggerSources / parseTriggerSeen
// 都按 TRIGGER_SOURCES 白名单遍历，会被自然忽略，不会报错也不会被读到。
export type TriggerSource = 'github' | 'http' | 'selfhost' | 'tencent' | 'aliyun';

export const TRIGGER_SOURCES: TriggerSource[] = ['github', 'http', 'selfhost', 'tencent', 'aliyun'];

export const TRIGGER_LABELS: Record<TriggerSource, string> = {
  github: 'GitHub Actions',
  http: '外部定时服务（cron-job.org 等）',
  selfhost: '自建驱动（self-hosted）',
  tencent: '腾讯云云函数 SCF',
  aliyun: '阿里云函数计算 FC',
};

// 默认开关：三个外部渠道全开，两个云函数默认关（按需启用）
export const DEFAULT_TRIGGER_SOURCES: Record<TriggerSource, boolean> = {
  github: true,
  http: true,
  selfhost: true,
  tencent: false,
  aliyun: false,
};

// 断档判定阈值（秒）：已启用的渠道超过该时长没有触发即告警（默认 30 分钟）
export const TRIGGER_GAP_THRESHOLD_SEC = 30 * 60;

// 来源识别：外部服务可通过 ?source=xxx 或 X-Trigger-Source: xxx 声明身份。
// 未声明时归为 http（兼容 cron-job.org、自架 curl cron 等既有配置）。
export function normalizeSource(raw: string | null | undefined): TriggerSource {
  const v = (raw || '').trim().toLowerCase();
  if (v === 'github' || v === 'github_actions' || v === 'actions') return 'github';
  if (v === 'selfhost' || v === 'self-host' || v === 'self_host' || v === 'driver') return 'selfhost';
  // 'cron' / 'scheduled' 这两个历史别名不再映射到 native（该渠道已移除），
  // 按下方兜底归入 http，行为与移除前一致。
  if (v === 'tencent' || v === 'scf' || v === 'tencent_cloud' || v === 'tencentcloud') return 'tencent';
  if (v === 'aliyun' || v === 'fc' || v === 'alicloud' || v === 'aliyun_fc') return 'aliyun';
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
