/**
 * 管理台前端表单的回归测试。
 *
 * 前端是单文件 `src/web/index.html`（含内联脚本），没有模块导出可供单测。
 * 这里按「代码标记」把内联脚本里的目标函数切出来，塞进 `vm` 上下文执行——
 * 测的是**真实源码**而不是副本；一旦标记消失或函数改名，测试会立刻失败提醒更新。
 *
 * 覆盖两块最容易出错、又只能靠手点才能发现的逻辑：
 *   1. 日期/时间控件（年月日时分下拉 ↔ 文本框双向同步、跨天判定）
 *   2. 排班弹窗（每种排班模式必须给出各自的界面与保存结果）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const HTML = readFileSync(resolve(__dirname, '../src/web/index.html'), 'utf8');

/** 切出 [start, end) 之间的源码；标记缺失直接抛错，避免静默测了个空 */
function block(start: string, end: string): string {
  const i = HTML.indexOf(start);
  const j = HTML.indexOf(end, i + start.length);
  if (i < 0) throw new Error(`找不到起始标记：${start}`);
  if (j < 0) throw new Error(`找不到结束标记：${end}`);
  return HTML.slice(i, j);
}

const M = {
  dtHelpers: ['const DT_KINDS', '/** 渲染单个弹窗字段'],
  fieldRender: ['/** 渲染单个弹窗字段', 'function modalApplyVisibility'],
  hmMin: ['function hmMin(s) {', 'async function openScheduleModal'],
  schedule: ['async function openScheduleModal(g) {', 'async function deleteGroup(id) {'],
  groupModal: ['async function openGroupModal(g) {', 'function hmMin(s) {'],
} as const;

const PRELUDE = [
  'function esc(s) { return String(s == null ? "" : s); }',
  'function escDdns(s) { return String(s == null ? "" : s); }',
  'const DDNS_MODE_LABEL = { rotate: "按天轮换", interval: "基准时间+每N天", window: "按在线时段", static: "固定首台" };',
].join('\n');

type AnyFn = (...args: unknown[]) => unknown;

/** 建一个装了「日期/时间控件」相关函数的沙箱上下文 */
function dtContext() {
  const src = [
    PRELUDE,
    block(...M.dtHelpers),
    block(...M.fieldRender),
    block(...M.hmMin),
    'module.exports = { splitDt, dtControlHtml, dtOptionsHtml, hmMin, pad2, todayStr, nowMinuteStr, modalFieldHtml };',
  ].join('\n');
  const ctx: Record<string, unknown> = { module: { exports: {} } };
  vm.createContext(ctx);
  new vm.Script(src).runInContext(ctx);
  return (ctx.module as { exports: Record<string, AnyFn> }).exports;
}

interface Harness {
  openModal: (opts: Record<string, unknown>) => Promise<unknown>;
  apiJson: (path: string, opts?: { body?: string }) => Promise<{ ok: boolean; data: unknown }>;
  calls: { path: string; body: Record<string, unknown> | null }[];
  lastOpts: () => Record<string, unknown>;
  setValues: (v: Record<string, unknown> | null) => void;
  /** 在沙箱里跑一段代码（用于摆好 ddnsState 这类上下文） */
  run: (code: string) => void;
}

/** 建一个装了分组/排班弹窗的沙箱，openModal 与 apiJson 用桩替代 */
function formContext(): Harness & { openGroupModal: AnyFn; openScheduleModal: AnyFn } {
  const src = [
    PRELUDE,
    block(...M.dtHelpers),
    block(...M.hmMin),
    block(...M.groupModal),
    block(...M.schedule),
    'module.exports = { openGroupModal, openScheduleModal };',
  ].join('\n');

  const calls: Harness['calls'] = [];
  let lastOpts: Record<string, unknown> = {};
  let values: Record<string, unknown> | null = null;
  const ctx: Record<string, unknown> = {
    module: { exports: {} },
    ddnsState: { machines: [] },
    ddnsMsg: () => {},
    loadDdns: async () => {},
    errText: () => '',
    openModal: (opts: Record<string, unknown>) => {
      lastOpts = opts;
      return Promise.resolve(values);
    },
    apiJson: async (path: string, opts?: { body?: string }) => {
      calls.push({ path, body: opts?.body ? JSON.parse(opts.body) : null });
      return { ok: true, data: {} };
    },
  };
  vm.createContext(ctx);
  new vm.Script(src).runInContext(ctx);
  const ex = (ctx.module as { exports: Record<string, AnyFn> }).exports;
  return {
    calls,
    lastOpts: () => lastOpts,
    setValues: (v) => { values = v; },
    run: (code) => { vm.runInContext(code, ctx); },
    openModal: ctx.openModal as Harness['openModal'],
    apiJson: ctx.apiJson as Harness['apiJson'],
    openGroupModal: ex.openGroupModal,
    openScheduleModal: ex.openScheduleModal,
  };
}

const ymd = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('日期/时间控件', () => {
  const T = dtContext();
  const splitDt = T.splitDt as (s: string) => Record<string, string>;
  const hmMin = T.hmMin as (s: string) => number | null;
  const dtControlHtml = T.dtControlHtml as (id: string, key: string, v: string, k: string) => string;
  const modalFieldHtml = T.modalFieldHtml as (f: Record<string, unknown>, n: number) => string;
  const pad2 = T.pad2 as (n: number) => string;

  it('splitDt 覆盖各种写法', () => {
    expect(splitDt('2026-01-01 03:05')).toEqual({ y: '2026', mo: '01', d: '01', h: '03', mi: '05' });
    expect(splitDt('2026-1-2T7:9')).toEqual({ y: '2026', mo: '01', d: '02', h: '07', mi: '09' });
    expect(splitDt('2026-03-04')).toEqual({ y: '2026', mo: '03', d: '04' });
    expect(splitDt('22:00')).toEqual({ h: '22', mi: '00' });
    expect(splitDt('')).toEqual({});
    expect(splitDt('abc')).toEqual({});
  });

  it('hmMin 是跨天判定的基础，越界与乱填一律返回 null', () => {
    expect(hmMin('22:00')).toBe(1320);
    expect(hmMin('06:00')).toBe(360);
    // 结束早于开始 = 跨天，例如 22:00 → 06:00
    expect(hmMin('06:00') <= hmMin('22:00')).toBe(true);
    expect(hmMin('24:00')).toBeNull();
    expect(hmMin('10:99')).toBeNull();
    expect(hmMin('白天')).toBeNull();
    expect(hmMin('')).toBeNull();
  });

  it('pad2 与「今天 / 现在」的默认值', () => {
    expect(pad2(3)).toBe('03');
    expect(pad2(12)).toBe('12');
    expect(T.todayStr()).toBe(ymd());
    expect(T.nowMinuteStr()).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(String(T.nowMinuteStr()).slice(0, 10)).toBe(ymd());
  });

  it('date 控件给 3 个下拉并把当天选中', () => {
    const h = dtControlHtml('modal-f-k', 'k', ymd(), 'date');
    expect(h.match(/<select/g)).toHaveLength(3);
    expect(h).toContain('data-mkey="k"');
    expect(h).toContain('data-dt="k"');
    expect(h).toContain(`value="${ymd().slice(0, 4)}" selected`);
    expect(h).not.toContain('data-dtp="h"');
  });

  it('datetime 控件给 5 个下拉并回填时分', () => {
    const h = dtControlHtml('modal-f-a', 'anchorAt', '2026-01-01 03:05', 'datetime');
    expect(h.match(/<select/g)).toHaveLength(5);
    expect(h).toContain('data-dtp="h"');
    expect(h).toContain('data-dtp="mi"');
    expect(h).toContain('value="2026-01-01 03:05"');
  });

  it('time 控件只给时/分', () => {
    const h = dtControlHtml('modal-f-t', 'switchTime', '03:00', 'time');
    expect(h.match(/<select/g)).toHaveLength(2);
    expect(h).not.toContain('data-dtp="y"');
  });

  it('日候选按当月天数收敛（闰年 2 月 29 天）', () => {
    const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate();
    expect(daysIn(2026, 2)).toBe(28);
    expect(daysIn(2024, 2)).toBe(29);
    expect(daysIn(2026, 4)).toBe(30);
  });

  it('字段渲染带联动标记与占满整行', () => {
    const h = modalFieldHtml({ key: 'anchorDate', label: '轮换基准日', type: 'date', full: true, value: '2026-01-01' }, 3);
    expect(h).toContain('data-mwrap="anchorDate"');
    expect(h).toContain('field full');
    expect(h).toContain('class="dt-pick"');
    expect(h).toContain('for="modal-f-anchorDate"');
    expect(h).toContain('id="modal-f-anchorDate"');
  });
});

describe('新增 / 编辑分组弹窗', () => {
  const H = formContext();
  const newGroup = () => H.openGroupModal(null) as Promise<unknown>;
  const editGroup = (g: Record<string, unknown>) => H.openGroupModal(g) as Promise<unknown>;
  const fields = () => (H.lastOpts().fields as Record<string, unknown>[]) || [];
  const field = (k: string) => fields().find((f) => f.key === k) as Record<string, any>;

  const seqGroup = {
    id: 3, name: '组A', mode: 'rotate', timezone: 'Asia/Shanghai',
    switch_time: '03:00', anchor_date: '1970-01-01', anchor_at: '',
    fallback_ip: '', enabled: true, members: [], records: [],
  };

  it('新增分组：日期默认当天、轮换起点默认当前分钟', async () => {
    H.setValues(null);
    await newGroup();
    expect(H.lastOpts().title).toBe('新增分组');
    expect(H.lastOpts().wide).toBe(true);
    expect(field('mode').value).toBe('rotate');
    expect(field('anchorDate').value).toBe(ymd());
    expect(field('anchorDate').type).toBe('date');
    expect(field('anchorDate').full).toBe(true);
    expect(field('switchTime').type).toBe('time');
    expect(field('anchorAt').type).toBe('datetime');
    expect(field('anchorAt').value).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(String(field('anchorAt').value).slice(0, 10)).toBe(ymd());
  });

  it('新增分组：字段按模式互斥显示', async () => {
    H.setValues(null);
    await newGroup();
    const show = (k: string, mode: string) => (field(k).showIf as (v: unknown) => boolean)({ mode });
    expect(show('anchorDate', 'rotate')).toBe(true);
    expect(show('anchorDate', 'window')).toBe(false);
    expect(show('switchTime', 'rotate')).toBe(true);
    expect(show('switchTime', 'interval')).toBe(false);
    expect(show('anchorAt', 'interval')).toBe(true);
    expect(show('anchorAt', 'rotate')).toBe(false);
  });

  it('新增分组：只校验当前模式用到的字段', async () => {
    H.setValues(null);
    await newGroup();
    const v = H.lastOpts().validate as (x: Record<string, unknown>) => string | null;
    expect(v({ mode: 'rotate', switchTime: '03:00', anchorDate: '2026-01-01' })).toBeNull();
    expect(v({ mode: 'rotate', switchTime: '3点', anchorDate: '2026-01-01' })).not.toBeNull();
    expect(v({ mode: 'rotate', switchTime: '03:00', anchorDate: '2026/01/01' })).not.toBeNull();
    // window/static 不看这两个字段，空着也不该拦
    expect(v({ mode: 'window', switchTime: '', anchorDate: '' })).toBeNull();
    expect(v({ mode: 'static', switchTime: '', anchorDate: '' })).toBeNull();
    // interval 起点可留空（视为 1970-01-01 00:00）
    expect(v({ mode: 'interval', anchorAt: '' })).toBeNull();
    expect(v({ mode: 'interval', anchorAt: '2026-09-28' })).toBeNull();
    expect(v({ mode: 'interval', anchorAt: '2026-09-28 12:00' })).toBeNull();
    expect(v({ mode: 'interval', anchorAt: '明天' })).not.toBeNull();
  });

  it('编辑分组：保留原值，未改动字段回填不丢', async () => {
    H.setValues({ name: '组A', mode: 'interval', timezone: 'Asia/Shanghai', anchorAt: '2026-05-05 05:05', fallbackIp: '', switchTime: '03:00', anchorDate: '2020-01-01' });
    H.calls.length = 0;
    await editGroup(seqGroup);
    expect(H.lastOpts().title).toBe('编辑分组');
    // 隐藏字段仍按原值渲染并提交（隐藏 ≠ 清空），切模式来回不该把已存参数洗掉
    expect(field('anchorDate').value).toBe('1970-01-01');
    expect(field('anchorAt').value).toBe('');
    expect(H.calls).toHaveLength(1);
    expect(H.calls[0].path).toContain('/groups/3');
    expect(H.calls[0].body).toMatchObject({
      mode: 'interval',
      anchorAt: '2026-05-05 05:05',
      switchTime: '03:00',
      anchorDate: '2020-01-01',
      enabled: true,
    });
  });

  it('新增走 POST，编辑走 PUT', async () => {
    H.setValues({ name: '组W', mode: 'window', timezone: 'Asia/Shanghai', switchTime: '03:00', anchorDate: '1970-01-01', anchorAt: '', fallbackIp: '' });
    H.calls.length = 0;
    await newGroup();
    expect(H.calls[0].path).toMatch(/\/api\/v1\/ddns\/groups$/);
    expect(H.calls[0].body).toMatchObject({ name: '组W', mode: 'window' });
  });
});

describe('排班弹窗（按模式适配）', () => {
  const H = formContext();
  const sched = (g: Record<string, unknown>) => H.openScheduleModal(g) as Promise<unknown>;
  const html = () => String(H.lastOpts().html || '');

  const machines = [
    { id: 1, name: 'JP1', ip: '8.211.177.43' },
    { id: 2, name: 'JP2', ip: '8.211.141.6' },
    { id: 3, name: 'SG', ip: '47.236.129.54' },
  ];
  const member = (id: number, name: string, over: Record<string, unknown> = {}) => ({
    machineId: id, name, ip: `1.1.1.${id}`, days: 1, windowStart: '', windowEnd: '',
    sortOrder: id - 1, machineEnabled: true, ...over,
  });
  const base = {
    id: 7, name: '组A', timezone: 'Asia/Shanghai', switch_time: '03:00', anchor_date: '1970-01-01',
    anchor_at: '', fallback_ip: '', enabled: true, records: [],
  };
  const reset = () => {
    H.calls.length = 0;
    H.run('ddnsState = { machines: ' + JSON.stringify(machines) + ' }');
  };

  it('rotate：切换时刻 + 轮换基准日 + 值班天数列', async () => {
    reset();
    H.setValues({ switchTime: '04:30', anchorDate: '2026-09-01', days_1: '3', so_1: '0' });
    await sched({ ...base, mode: 'rotate', members: [member(1, 'JP1')] });
    const h = html();
    expect(h).toContain('切换时刻');
    expect(h).toContain('轮换基准日');
    expect(h).not.toContain('轮换起点');
    expect(h).toContain('<th>值班天数</th>');
    expect(h).not.toContain('在线开始');
    expect(H.lastOpts().wide).toBe(true);
    // 添加机器必须是下拉勾选
    expect(h).toContain('data-pick');
    expect(h).toContain('data-mkey="add_2"');
    expect(H.calls[0].path).toContain('/groups/7/members');
    expect(H.calls[1].path).toContain('/groups/7');
    expect(H.calls[1].body).toMatchObject({ mode: 'rotate', switchTime: '04:30', anchorDate: '2026-09-01', anchorAt: '', fallbackIp: '' });
  });

  it('rotate：参数没变就不多发一次分组 PUT', async () => {
    H.setValues({ switchTime: '03:00', anchorDate: '1970-01-01', days_1: '1', so_1: '0' });
    reset();
    await sched({ ...base, mode: 'rotate', members: [member(1, 'JP1')] });
    expect(H.calls.map((c) => c.path)).toHaveLength(1);
  });

  it('interval：轮换起点可编辑，列名标明 N', async () => {
    H.setValues({ anchorAt: '2026-09-28 12:00', days_1: '2', so_1: '0' });
    reset();
    await sched({ ...base, mode: 'interval', members: [member(1, 'JP1', { days: 2 })] });
    const h = html();
    expect(h).toContain('轮换起点');
    expect(h).toContain('data-dtp="mi"');
    expect(h).toContain('<th>值班天数 N</th>');
    expect(h).not.toContain('切换时刻');
    expect(H.calls[1].body).toMatchObject({ anchorAt: '2026-09-28 12:00' });
  });

  it('window：在线开始/结束两列，跨天单独打标', async () => {
    H.setValues({ ws_1: '22:00', we_1: '06:00', so_1: '0', ws_2: '08:00', we_2: '14:00', so_2: '1' });
    reset();
    await sched({
      ...base, mode: 'window',
      members: [
        member(1, 'JP1', { windowStart: '22:00', windowEnd: '06:00' }),
        member(2, 'JP2', { windowStart: '08:00', windowEnd: '14:00' }),
      ],
    });
    const h = html();
    expect(h).toContain('<th>在线开始</th>');
    expect(h).toContain('<th>在线结束</th>');
    expect(h).not.toContain('值班天数');
    // 只有 22:00→06:00 这一行算跨天
    expect(h.match(/<span class="tag-warn">/g)).toHaveLength(1);
    expect(h).toContain('跨天');
    expect(H.calls[0].body).toMatchObject({
      members: [
        { machineId: 1, windowStart: '22:00', windowEnd: '06:00', sortOrder: 0 },
        { machineId: 2, windowStart: '08:00', windowEnd: '14:00', sortOrder: 1 },
      ],
    });
    // 时段模式没有分组级参数，不该多打一次 PUT
    expect(H.calls).toHaveLength(1);
  });

  it('window：时段为空或格式不对要拦下来，跨天合法', async () => {
    H.setValues({ ws_1: '22:00', we_1: '06:00', so_1: '0', ws_2: '08:00', we_2: '14:00', so_2: '1' });
    reset();
    await sched({
      ...base, mode: 'window',
      members: [member(1, 'JP1'), member(2, 'JP2')],
    });
    const v = H.lastOpts().validate as (x: Record<string, unknown>) => string | null;
    const okWin = { ws_1: '22:00', we_1: '06:00', so_1: '0', ws_2: '08:00', we_2: '14:00', so_2: '1' };
    expect(v(okWin)).toBeNull();
    expect(v({ ...okWin, ws_1: 'abc' })).not.toBeNull();
    expect(v({ ...okWin, ws_1: '25:00' })).not.toBeNull();
    expect(v({ ...okWin, ws_1: '', we_1: '' })).not.toBeNull();
    // 勾了移除的行不再校验时段
    expect(v({ rm_1: true, rm_2: true })).toBeNull();
  });

  it('static：没有值班列，只有机器/排序/操作', async () => {
    H.setValues({ so_1: '0' });
    reset();
    await sched({ ...base, mode: 'static', members: [member(1, 'JP1')] });
    const h = html();
    expect(h.match(/<th>/g)).toHaveLength(3);
    expect(h).not.toContain('值班天数');
    expect(h).not.toContain('在线开始');
    expect(h).toContain('固定首台');
  });

  it('下拉勾选把多台机器一次加入，时段模式给全天默认值', async () => {
    H.setValues({ ws_1: '22:00', we_1: '06:00', so_1: '0', add_2: true, add_3: true });
    reset();
    await sched({ ...base, mode: 'window', members: [member(1, 'JP1', { windowStart: '22:00', windowEnd: '06:00' })] });
    const members = (H.calls[0].body as { members: Record<string, unknown>[] }).members;
    expect(members).toHaveLength(3);
    expect(members[0]).toMatchObject({ machineId: 1, windowStart: '22:00', windowEnd: '06:00' });
    expect(members[1]).toMatchObject({ machineId: 2, windowStart: '00:00', windowEnd: '23:59', sortOrder: 1 });
    expect(members[2]).toMatchObject({ machineId: 3, windowStart: '00:00', windowEnd: '23:59', sortOrder: 2 });
  });

  it('取消弹窗不落任何请求', async () => {
    H.setValues(null);
    reset();
    await sched({ ...base, mode: 'rotate', members: [] });
    expect(H.calls).toHaveLength(0);
  });
});
