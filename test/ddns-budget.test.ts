// DDNS 同步的 subrequest 护栏回归测试（第四轮审查 P0-R4-1）
//
// 事故回放：护栏最初被拍成 20，但 DDNS 同步与监控跑在同一个 invocation 里、
// 监控已占 ~35，于是 35 + 20 = 55 > 50（Free 上限）——护栏反而成了一张
// 「合法的越线许可证」。而且它只数厂商 fetch，没数同循环里的 D1 读/写。
//
// 这组用例锁两件事：阈值必须留在剩余预算内、推导链 / D1 计数不许被删掉。

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DDNS_SUBREQUEST_BUDGET } from '../src/ddns/sync';

const SRC_PATH = new URL('../src/ddns/sync.ts', import.meta.url);
const src = readFileSync(SRC_PATH, 'utf8');

/** 取某个调用点前面的一段源码，用于判断「这次 I/O 有没有被计入护栏」 */
function beforeCall(needle: string, span = 300): string {
  const idx = src.indexOf(needle);
  expect(idx, `源码里找不到 ${needle}`).toBeGreaterThan(-1);
  return src.slice(Math.max(0, idx - span), idx);
}

describe('DDNS 同步 subrequest 护栏', () => {
  it('阈值必须留在「50 − 监控峰值」之外的剩余预算内', () => {
    // 50（Cloudflare Free 单次请求上限） − 35（监控周期峰值） = 15
    // 护栏若比 15 还大，就等于允许它自己把整轮 cron 拖到 1101
    expect(DDNS_SUBREQUEST_BUDGET).toBeLessThanOrEqual(15);
  });

  it('常量必须写明推导链（标准：预算常量不得拍脑袋）', () => {
    const idx = src.indexOf('export const DDNS_SUBREQUEST_BUDGET');
    expect(idx).toBeGreaterThan(-1);
    // 推导链至少要出现「50」和「35」这两个数字，后人改监控预算时才知道要同步改这里
    const doc = src.slice(Math.max(0, idx - 1200), idx);
    expect(doc).toMatch(/50/);
    expect(doc).toMatch(/35/);
  });

  it('护栏计数必须覆盖 D1，不能只数厂商 fetch', () => {
    // D1 的读和写同样计入 50 上限。这三条是切换时刻的主要 D1 开销，
    // 每一条前面都必须有 spent++（或 spent += n）。
    expect(beforeCall('store.readCredential(env, rec)')).toMatch(/spent\+\+/);
    expect(beforeCall('store.markSynced(env, rec.id, targetIp')).toMatch(/spent\+\+/);
    // 用带 errMsg 的完整串定位失败分支（未知厂商分支里也有同名调用）
    expect(beforeCall('store.markSynced(env, rec.id, rec.current_ip, rec.zone_id, rec.record_id, errMsg'))
      .toMatch(/spent\s*\+=/);
  });

  it('同一凭据在一轮内只解密一次（N+1 回归）', () => {
    // P1-R4-2：readCredential 前应有 credCache 命中判断，避免每条记录各付一次 D1 读 + 解密
    expect(beforeCall('cred = await store.readCredential(env, rec)', 400)).toMatch(/credCache\.get/);
  });
});
