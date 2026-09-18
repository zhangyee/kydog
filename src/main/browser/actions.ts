import { KydogError } from '../../shared/errors';
import type { AxSnapshot } from './snapshot';

/**
 * 动作 → CDP 参数的纯映射，以及批次的展开与校验。
 * 这里不碰 webContents —— 所有需要真页面的事都在 browserService 里做。
 */

/** 定位方式两种，用途不同：selector 用于重放已探明的剧本，index 用于探索期。 */
export type TargetSpec = { selector: string } | { index: number; snapshotId: string };

export type WaitUntil =
  | { selector: string; state: 'present' | 'absent' }
  | { urlMatches: string };

export type Action =
  | ({ kind: 'click' } & TargetSpec)
  | ({ kind: 'hover' } & TargetSpec)
  | ({ kind: 'type'; text: string } & TargetSpec)
  | ({ kind: 'select'; value: string } & TargetSpec)
  | { kind: 'key'; key: string }
  | { kind: 'scroll'; direction: 'up' | 'down'; amount?: number }
  | { kind: 'extract'; selectors: Record<string, string> }
  | { kind: 'wait'; until: WaitUntil; timeoutMs?: number }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'reload' }
  | { kind: 'repeat'; times: number; actions: Action[] };

/** 容量上限。资源保护，不参与任何语义判断 —— 挡的是「一个写错的剧本把上下文刷爆」。 */
export const MAX_REPEAT_TIMES = 10;
export const MAX_STEPS = 60;

/** `wait.timeoutMs` 的默认值与上限（spec §5.5）。**上限不是可选的**：没有它，
 *  一个 sequential 工具能把整轮 run 卡满一个自定的时限，而用户只看到「操作网页」
 *  转圈。两个数同时落在这里与 browser_act 的 TypeBox schema 上 —— schema 那层是
 *  模型第一眼看到的契约。 */
export const WAIT_DEFAULT_MS = 8_000;
export const WAIT_MAX_MS = 30_000;

/** spec §4.1 的九种动作，加上 Task 2 补的 back / forward / reload 三种，一个不多。
 *  **白名单是必须的**：没有它，
 *  `{kind:'navigate', url:'https://evil/'}` 一路通过校验、落到派发的 default 分支，
 *  只要带 selector 就会回报「navigate → #x」—— 模型得到一句「做过了」，
 *  实际什么都没发生。而 `{kind:'submit'}` 报的是「快照编号失效」，
 *  模型于是按错误提示去重取快照，永远走不出去。 */
export const ACTION_KINDS = [
  'click', 'type', 'key', 'scroll', 'hover', 'select', 'extract', 'wait', 'repeat',
  'back', 'forward', 'reload',
] as const;
const KIND_SET: ReadonlySet<string> = new Set(ACTION_KINDS);

/** 需要目标的四种。`key` / `scroll` / `extract` / `wait` / `repeat` /
 *  `back` / `forward` / `reload` 不需要 —— spec §4.1 里 `{kind:'scroll', direction:'down'}`
 *  既没 selector 也没 index，让它走 resolveTarget 只会拿到一句说的是另一件事的错。
 *  **派发那一侧要先问这个**。 */
export const TARGETED_KINDS = ['click', 'hover', 'type', 'select'] as const;
export type TargetedAction = Extract<Action, { kind: (typeof TARGETED_KINDS)[number] }>;
const TARGETED_SET: ReadonlySet<string> = new Set(TARGETED_KINDS);

export function needsTarget(a: { kind: string }): boolean {
  return TARGETED_SET.has(a.kind);
}

/**
 * 派发侧真正要碰页面的那几种。
 *
 * `repeat` 在 `flattenActions` 里就展开没了；`extract` 跑在工具层（它要整批预算）；
 * `wait` 走 `browserService.waitFor`；`back` / `forward` / `reload` 走
 * `browserService.historyNav`（要走 `navigate` 那条路才有导航观测，`dispatch` 给不了）。
 * 剩下这六种才是 `dispatch` 的输入。
 * 写成 `Exclude` 而不是手写联合：`Action` 加了新成员时，派发侧要么处理它、
 * 要么在这里显式排除，两边不会静默漂开。
 */
export type DispatchAction =
  Exclude<Action, { kind: 'repeat' | 'extract' | 'wait' | 'back' | 'forward' | 'reload' }>;

export type FlatStep = {
  action: Exclude<Action, { kind: 'repeat' }>;
  /** 出错时如实说清停在哪 —— 「第 3 轮第 2 个动作」比「第 6 步」有用得多。 */
  label: string;
};

const bad = (msg: string) => new KydogError('browser.bad_action', msg);

function isRepeat(a: Action): a is Extract<Action, { kind: 'repeat' }> {
  return a.kind === 'repeat';
}

/**
 * 目标的形状检查，说得清哪里不对。
 *
 * 抽出来是因为两处都要：`validateBatch` 在整批跑起来**之前**拦一次（前 k-1 个动作
 * 已经生效之后再报错，网页是不可回滚的），`resolveTarget` 自己也要 fail-closed ——
 * 它是导出的纯函数，谁都可以直接调。
 *
 * 返回 `null` 表示形状没问题，否则是给模型看的那句话。
 */
function targetProblem(spec: unknown): string | null {
  if (!spec || typeof spec !== 'object') return '这个动作需要一个目标，但一个都没给';
  const s = spec as { selector?: unknown; index?: unknown; snapshotId?: unknown };
  if (s.selector !== undefined) {
    if (typeof s.selector !== 'string' || s.selector.trim() === '') return 'selector 不能为空';
    return null;
  }
  // 「没有 selector」不等于「这是 index 形式」。不查这一步的话，一个既没 selector
  // 也没 index 的动作会被当成 index 形式，报出「编号来自快照 undefined」——
  // 整批停在这里，而错误原因说的是另一件事。
  if (s.index === undefined) {
    return '这个动作需要一个目标：要么给 selector（重放已探明的剧本），'
      + '要么给 index + snapshotId（探索期，编号来自那一份快照）';
  }
  if (typeof s.index !== 'number' || !Number.isInteger(s.index)) {
    return `index 必须是整数，收到 ${JSON.stringify(s.index)}`;
  }
  if (typeof s.snapshotId !== 'string' || s.snapshotId === '') {
    return 'index 必须带上产生它的 snapshotId —— 编号只在那一份快照里有效，绝不拿它去查当前页面';
  }
  return null;
}

/**
 * `wait.until` 的三种形态：`{selector, state?}`、`{urlMatches}`。
 *
 * **形态不合一律拒绝，不猜**：`{}` 或只给 `state` 时挑一个默认条件出来，等于替模型
 * 编一件它没说过的事 —— 而 wait 的语义是「等某件明确的事发生」，等错了会让下游
 * 在旧 DOM 上继续跑并且不报任何错（spec §4.2 百度学术那一段）。
 *
 * 两种形态混在一起也拒：那是「没说清要等什么」，不是「两个条件都要」。
 */
export function parseWaitUntil(until: unknown): WaitUntil {
  if (!until || typeof until !== 'object') {
    throw bad('wait.until 必须是 {selector, state?} 或 {urlMatches} 之一');
  }
  const u = until as { selector?: unknown; state?: unknown; urlMatches?: unknown };
  const hasSelector = u.selector !== undefined;
  const hasUrl = u.urlMatches !== undefined;
  if (hasSelector === hasUrl) {
    throw bad('wait.until 只能是 {selector, state?} 或 {urlMatches} 之中的一种，不能都给也不能都不给');
  }
  if (hasUrl) {
    if (typeof u.urlMatches !== 'string' || u.urlMatches.trim() === '') throw bad('wait.until.urlMatches 不能为空');
    return { urlMatches: u.urlMatches };
  }
  if (typeof u.selector !== 'string' || u.selector.trim() === '') throw bad('wait.until.selector 不能为空');
  const state = u.state === undefined ? 'present' : u.state;
  if (state !== 'present' && state !== 'absent') {
    throw bad(`wait.until.state 只能是 present 或 absent，收到 ${JSON.stringify(u.state)}`);
  }
  return { selector: u.selector, state };
}

/**
 * 动作自己的形状：**缺了它非有不可的那个字段就当场拒**。
 *
 * 与 `targetProblem`（目标怎么定位）是两件事。TypeBox 那层挡不住这些 ——
 * `text` / `value` / `direction` 在 schema 上都是 `Optional`，因为九种动作共用一份
 * 参数对象，没法逐种要求。于是 `{kind:'type', selector:'#q'}` 一路走到派发，
 * `Input.insertText` 收到 `undefined`；`{kind:'scroll'}` 走到派发时**没有方向**，
 * 派发侧只能替模型挑一个 —— 那就是替它编一件它没说过的事。
 *
 * **必须在整批跑起来之前**：网页不可回滚，前 k-1 个动作已经生效之后再报
 * 「第 k 个动作少了个字段」，代价是一次撤不回来的半成品操作。
 */
function validateShape(a: Action, where: string): void {
  const p = (msg: string) => bad(`${where}${a.kind}：${msg}`);
  if (a.kind === 'type') {
    // 空串没有定义好的语义：`Input.insertText('')` 的行为本项目没有量过，而「清空」
    // 也不是这一期的九种动作之一。fail-closed —— 不在真页面上试出一个不确定的结果。
    if (typeof a.text !== 'string' || a.text === '') {
      throw p(`要打进去的 text 必须是非空字符串，收到 ${JSON.stringify(a.text)}`);
    }
  }
  if (a.kind === 'select') {
    if (typeof a.value !== 'string') {
      throw p(`要选的 value 必须是字符串（与 <option value> 精确相等），收到 ${JSON.stringify(a.value)}`);
    }
  }
  if (a.kind === 'scroll') {
    if (a.direction !== 'up' && a.direction !== 'down') {
      throw p(`direction 只能是 up 或 down，收到 ${JSON.stringify(a.direction)}`);
    }
    const amt: unknown = a.amount;
    if (amt !== undefined && (typeof amt !== 'number' || !Number.isFinite(amt) || amt <= 0)) {
      throw p(`amount 是要滚多少 CSS 像素，必须是正的有限数（不给就滚一屏），收到 ${JSON.stringify(amt)}`);
    }
  }
  if (a.kind === 'key') {
    // 键名从前要等到派发那一刻才查 —— 那时前面几个动作已经生效了。
    // **`hasOwnProperty` 不能省**：`KEYS[k]` 走原型链，`constructor` / `toString` /
    // `valueOf` / `hasOwnProperty` 在任何对象上都是真值，白名单就不是白名单了。
    // 实测：那几个名字一路通过校验，`keyEventsFor` 也不抛，发出去的事件里
    // `code` 与 `windowsVirtualKeyCode` 双双是 undefined（JSON 里直接消失），
    // 而返回值是一句「按下 constructor」—— 一个不存在的键，报的是成功。
    if (typeof a.key !== 'string' || !hasKey(a.key)) {
      throw p(`不认识的按键 ${JSON.stringify(a.key)}，只支持：${Object.keys(KEYS).join(' / ')}`);
    }
  }
}

function validateWait(a: Extract<Action, { kind: 'wait' }>): void {
  parseWaitUntil(a.until);
  const ms: unknown = a.timeoutMs;
  if (ms === undefined) return;
  // NaN 单独挡：`NaN < 1` 与 `NaN > MAX` 都是 false，只写区间比较会把它放行。
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 1 || ms > WAIT_MAX_MS) {
    throw bad(`wait.timeoutMs 必须是 1..${WAIT_MAX_MS} 毫秒（不给就是默认 ${WAIT_DEFAULT_MS}），收到 ${String(ms)}`);
  }
}

export function validateBatch(actions: Action[]): void {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw bad('动作列表不能为空');
  }
  let steps = 0;
  for (const a of actions) {
    if (!a || typeof a !== 'object' || !KIND_SET.has((a as { kind: string }).kind)) {
      throw bad(`不认识的动作 ${JSON.stringify((a as { kind?: unknown })?.kind)}，`
        + `只支持：${ACTION_KINDS.join(' / ')}`);
    }
    if (needsTarget(a)) {
      const problem = targetProblem(a);
      if (problem !== null) throw bad(`${a.kind}：${problem}`);
    }
    validateShape(a, '');
    if (a.kind === 'wait') validateWait(a);
    if (!isRepeat(a)) { steps += 1; continue; }
    const t = a.times;
    if (!Number.isInteger(t) || t < 1 || t > MAX_REPEAT_TIMES) {
      throw bad(`repeat.times 必须是 1..${MAX_REPEAT_TIMES} 的整数，收到 ${String(t)}`);
    }
    if (!Array.isArray(a.actions) || a.actions.length === 0) throw bad('repeat.actions 不能为空');
    // 嵌套一层就能把 10×10 变成 100 步，两层 1000。不给这条路。
    if (a.actions.some(isRepeat)) throw bad('repeat 不允许嵌套');
    for (const inner of a.actions) {
      if (!inner || typeof inner !== 'object' || !KIND_SET.has((inner as { kind: string }).kind)) {
        throw bad(`repeat 里有不认识的动作 ${JSON.stringify((inner as { kind?: unknown })?.kind)}，`
          + `只支持：${ACTION_KINDS.join(' / ')}`);
      }
      if (needsTarget(inner)) {
        const problem = targetProblem(inner);
        if (problem !== null) throw bad(`repeat 里的 ${inner.kind}：${problem}`);
      }
      validateShape(inner, 'repeat 里的 ');
      if (inner.kind === 'wait') validateWait(inner);
    }
    // **乘 times**。丢掉这个乘数的话，10 轮 × 10 个动作只算 10 步、校验放行，
    // 而 flattenActions 展开出来是 100 步 —— 上限形同虚设。
    steps += t * a.actions.length;
  }
  // **超过**才拒，正好 MAX_STEPS 要放行：写成 >= 的话一个合法的满额剧本从此被拒，
  // 而这条路上没有任何别的信号会红。
  if (steps > MAX_STEPS) throw bad(`展开后有 ${steps} 个动作，超过上限 ${MAX_STEPS}`);
}

/**
 * 把一批动作铺平成可执行的步骤。
 *
 * **前提：调用方必须先跑 `validateBatch`。** 这个函数自己不查任何上限 ——
 * `repeat times=10 × 10 个动作` 在这里会老老实实展开成 100 步。上限只在
 * `validateBatch` 里，两者之间没有任何东西替调用方把关。
 *
 * 非 repeat 动作的编号数的是**请求里的位置**，不是展开后的步数：报错时给一个
 * 请求里根本不存在的序号，用户与模型都对不上号（而同一批里其余 label 说的
 * 都是「第几轮第几个」）。
 *
 * repeat 块自己展开出来的 label 也带上它在请求里的位置（「第 2 个动作的第 1 轮
 * 第 1 个动作」）——只写「第几轮第几个」的话，一批里两个 repeat 块各自的第一步
 * 都叫「第 1 轮第 1 个动作」，停在第三块时报错分不出是哪一块。
 */
export function flattenActions(actions: Action[]): FlatStep[] {
  const out: FlatStep[] = [];
  actions.forEach((a, i) => {
    if (!isRepeat(a)) {
      out.push({ action: a, label: `第 ${i + 1} 个动作` });
      return;
    }
    for (let round = 1; round <= a.times; round++) {
      a.actions.forEach((inner, j) => {
        out.push({
          action: inner as FlatStep['action'],
          label: `第 ${i + 1} 个动作的第 ${round} 轮第 ${j + 1} 个动作`,
        });
      });
    }
  });
  return out;
}

export type ResolvedTarget =
  | { kind: 'selector'; selector: string }
  | { kind: 'node'; nodeId: number; x: number; y: number; isPassword: boolean };

/**
 * 把定位规格解析成可执行的目标。
 *
 * `index` **必须**带上产生它的 `snapshotId`，而且只在那份快照里解析 ——
 * 绝不拿这个数字去查「当前」快照。理由是最危险的情况不是「编号不存在」
 * （那会报错），而是编号还在、指向的元素已经变了：那样不报错，只是点错东西。
 *
 * 形状先查一遍再谈快照：「既没 selector 也没 index」不是 index 形式的一种，
 * 把它当成 index 形式会报出一句说的是另一件事的错（见 `targetProblem`）。
 *
 * **返回的 x / y 是快照当时的坐标，不是此刻的。** 单位是视口内的 CSS px。
 * 调用方**必须在派发那一刻从活节点重新量**（spec §4.2 的第 2 条）：输入框展开一次、
 * 图片加载完一次，坐标就旧了 —— 而快照本身没变，`stale_index` 不会响。这里也
 * **不负责**把元素滚进视野、不判视口内外、不做命中检查（那三件同属 §4.2，
 * 在派发侧做）。拿这里的坐标直接发 `Input.dispatchMouseEvent` 会静默打偏。
 */
export function resolveTarget(spec: TargetSpec, snapshot: AxSnapshot | null): ResolvedTarget {
  const problem = targetProblem(spec);
  if (problem !== null) throw bad(problem);
  const s = spec as { selector?: string; index?: number; snapshotId?: string };
  if (s.selector !== undefined) {
    return { kind: 'selector', selector: s.selector };
  }
  if (!snapshot) {
    throw new KydogError('browser.stale_index', '这个标签还没有快照，编号无从解析 —— 先取一份快照');
  }
  if (snapshot.snapshotId !== s.snapshotId) {
    throw new KydogError('browser.stale_index',
      `编号来自快照 ${s.snapshotId}，当前快照是 ${snapshot.snapshotId} —— 页面已经变了，重新取一份再操作`);
  }
  const node = snapshot.nodes.find((n) => n.index === s.index);
  if (!node) {
    throw new KydogError('browser.stale_index', `快照 ${s.snapshotId} 里没有编号 ${s.index}`);
  }
  return {
    kind: 'node',
    nodeId: node.nodeId,
    // 点击坐标取元素**中心**，单位是 CSS px —— CDP 的 Input 事件就吃这个，
    // 按缩放换算过反而打不中（2026-09-08 spike 实测）。取左上角会打在边框上，
    // x/y 写反会打到别处，两种错 CDP 都不报，只是点不中。
    x: node.x + node.w / 2,
    y: node.y + node.h / 2,
    isPassword: node.isPassword === true,
  };
}

export type KeyEvent = {
  type: 'keyDown' | 'keyUp';
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
};

/**
 * 按键映射。**带不带 `text` 是这张表的重点，不是细节。**
 *
 * Chromium 的表单隐式提交发生在 `keypress`，而 CDP 的 `dispatchKeyEvent` 只有
 * `keyDown` 且带 `text` 时才产生 char 事件。漏了它，Enter 会静默地什么都不做 ——
 * 2026-09-08 侦察时在 Google Scholar 与百度学术上都撞到过，当时误判成
 * 「这两个站点不支持回车提交」。
 */
const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter:      { code: 'Enter',      vk: 13, text: '\r' },
  Tab:        { code: 'Tab',        vk:  9, text: '\t' },
  Escape:     { code: 'Escape',     vk: 27 },
  Backspace:  { code: 'Backspace',  vk:  8 },
  Delete:     { code: 'Delete',     vk: 46 },
  ArrowUp:    { code: 'ArrowUp',    vk: 38 },
  ArrowDown:  { code: 'ArrowDown',  vk: 40 },
  ArrowLeft:  { code: 'ArrowLeft',  vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  Home:       { code: 'Home',       vk: 36 },
  End:        { code: 'End',        vk: 35 },
  PageUp:     { code: 'PageUp',     vk: 33 },
  PageDown:   { code: 'PageDown',   vk: 34 },
};

/**
 * 白名单里的按键名，按表里的顺序。
 *
 * **导出只为一个读者**：`slowpaperDocConstants.test.ts` —— skill 文档里逐字列着这 13 个
 * 名字与「只认这 13 个」那个数，而文档里的名字与计数没有编译器管。这里给它一个**唯一出处**，
 * 免得那边再抄一份（抄一份就等于让测试对着自己的副本打勾）。
 */
export const KEY_NAMES: readonly string[] = Object.freeze(Object.keys(KEYS));

/**
 * 密码框硬闸：模型的 `type` 动作一律不许打进 `input[type="password"]`。
 *
 * 判据是元素类型这个**协议层事实**，不是「name 里有没有 password 字样」那种猜。
 * 一期 agent 不登录、不填账密：机构密码由主进程经 browser_login 填（见 §4.6），
 * 其余登录场景交给人。
 */
export function assertTypeAllowed(target: ResolvedTarget): void {
  if (target.kind === 'node' && target.isPassword) {
    throw new KydogError('browser.password_field',
      '不能往密码框里输入。机构登录用 browser_login（由主进程填），其他登录请交给用户');
  }
}

/** 白名单查表。**只认自有属性** —— 理由见 validateShape 里那段。 */
function hasKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(KEYS, key);
}

export function keyEventsFor(key: string): KeyEvent[] {
  const spec = hasKey(key) ? KEYS[key] : undefined;
  if (!spec) {
    throw bad(`不认识的按键 ${JSON.stringify(key)}，只支持：${Object.keys(KEYS).join(' / ')}`);
  }
  const base = { key, code: spec.code, windowsVirtualKeyCode: spec.vk };
  return [
    { type: 'keyDown', ...base, ...(spec.text ? { text: spec.text } : {}) },
    { type: 'keyUp', ...base },
  ];
}
