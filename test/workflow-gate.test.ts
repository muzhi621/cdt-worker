// GitHub Actions 触发链路的「渠道开关门控」回归测试（纯文本解析，无 D1 / 网络依赖）
//
// 背景（真实事故，2026-09-26 起潜伏、2026-10-05 被发现）：
//   cron.yml 里用 step 的 `exit 0` 表示「渠道已关闭则跳过」，但 GitHub Actions 中每个
//   `run:` 是独立 step、独立 shell —— `exit 0` 只是「本步成功结束」，**不会阻止后续 step**。
//   于是 gate 形同虚设：渠道关了，下一步仍每 5 分钟调一次 /__cron?source=github；
//   若 GitHub 侧密钥已过期，就被 401 拒绝并每小时留一条「密钥校验失败」日志 ——
//   用户看到的现象正是「开关已关闭，却一直有 401 日志」。
//
// 本测试把「触发步骤必须被 gate 用 if 门控」钉死，防止以后被改回 exit 0。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const WF = readFileSync(new URL('../.github/workflows/cron.yml', import.meta.url), 'utf8');

/** 按 `- name:` 把 workflow 切成 step 块（含该 step 的全部行） */
function splitSteps(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/);
  const blocks: string[] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    if (/^\s*-\s+name:\s*/.test(line)) {
      if (cur) blocks.push(cur.join('\n'));
      cur = [line];
    } else if (cur) {
      cur.push(line);
    }
  }
  if (cur) blocks.push(cur.join('\n'));
  return blocks;
}

/** 取 step 块里的一级标量字段（id: / if: / name:）。shell 里的 `if [` 不会误命中（要求紧跟冒号）。 */
function field(block: string, name: string): string {
  const m = block.match(new RegExp(`^\\s*${name}:\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1] : '';
}

/** 触发链路是否被 gate 真正门控。返回 detail 便于断言失败时定位。 */
function checkGate(yaml: string): { ok: boolean; detail: string } {
  const blocks = splitSteps(yaml);
  const gate = blocks.find((b) => b.includes('GITHUB_OUTPUT'));
  if (!gate) return { ok: false, detail: '找不到写 GITHUB_OUTPUT 的 gate 步骤' };
  const id = field(gate, 'id');
  if (!id) return { ok: false, detail: 'gate 步骤缺少 id，后续 step 无法引用其输出' };

  const trigger = blocks.find((b) => b.includes('/__cron?source=github'));
  if (!trigger) return { ok: false, detail: '找不到调用 /__cron?source=github 的触发步骤' };

  const cond = field(trigger, 'if');
  if (!cond) {
    return { ok: false, detail: '触发步骤没有 if 门控：step 内的 exit 0 不会阻止它执行（渠道关闭仍会照调）' };
  }
  if (!cond.includes(`steps.${id}.outputs.enabled`)) {
    return { ok: false, detail: `触发步骤 if 未引用 gate 输出：${cond}` };
  }
  return { ok: true, detail: `gated by steps.${id}.outputs.enabled` };
}

describe('cron.yml 触发链路：渠道开关必须真正门控', () => {
  it('触发步骤被 gate 的 if 门控（本次事故的核心断言）', () => {
    const r = checkGate(WF);
    expect(r.detail).toBeTruthy();
    expect(r.ok, r.detail).toBe(true);
  });

  it('反向自检：把 if 行删掉后必须判为「未门控」（证明上面的断言不是假绿）', () => {
    const broken = WF.replace(/^\s*if:\s*steps\.gate\.outputs\.enabled.*$/m, '');
    expect(broken).not.toBe(WF); // 确实替换掉了
    const r = checkGate(broken);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('没有 if 门控');
  });

  it('反向自检：gate 步骤的 id 被抹掉后必须判为「缺 id」', () => {
    const broken = WF.replace(/^\s*id:\s*gate\s*$/m, '');
    expect(broken).not.toBe(WF);
    const r = checkGate(broken);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('缺少 id');
  });

  it('gate 同时写出 enabled=true / enabled=false 两个分支', () => {
    const gate = splitSteps(WF).find((b) => b.includes('GITHUB_OUTPUT'))!;
    expect(gate).toContain('"enabled=true" >> "$GITHUB_OUTPUT"');
    expect(gate).toContain('"enabled=false" >> "$GITHUB_OUTPUT"');
  });

  it('gate 在密钥过期（401）时给出 ::warning:: 提醒同步密钥，而不是静默跳过', () => {
    const gate = splitSteps(WF).find((b) => b.includes('GITHUB_OUTPUT'))!;
    expect(gate).toContain('::warning::');
    expect(gate).toContain('401');
  });

  it('schedule 仍是每 5 分钟一次（改动本文件不应顺手改频率）', () => {
    expect(WF).toMatch(/cron:\s*'\*\/5 \* \* \* \*'/);
  });

  it('触发请求仍带 X-Cron-Secret 头与 ?source=github（渠道身份不被顺手改掉）', () => {
    const trigger = splitSteps(WF).find((b) => b.includes('/__cron?source=github'))!;
    expect(trigger).toContain('X-Cron-Secret');
    expect(trigger).toContain('/__cron?source=github');
  });
});
