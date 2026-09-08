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
  | { kind: 'repeat'; times: number; actions: Action[] };

/** 容量上限。资源保护，不参与任何语义判断 —— 挡的是「一个写错的剧本把上下文刷爆」。 */
export const MAX_REPEAT_TIMES = 10;
export const MAX_STEPS = 60;

export type FlatStep = {
  action: Exclude<Action, { kind: 'repeat' }>;
  /** 出错时如实说清停在哪 —— 「第 3 轮第 2 个动作」比「第 6 步」有用得多。 */
  label: string;
};

const bad = (msg: string) => new KydogError('browser.bad_action', msg);

function isRepeat(a: Action): a is Extract<Action, { kind: 'repeat' }> {
  return a.kind === 'repeat';
}

export function validateBatch(actions: Action[]): void {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw bad('动作列表不能为空');
  }
  let steps = 0;
  for (const a of actions) {
    if (!isRepeat(a)) { steps += 1; continue; }
    const t = a.times;
    if (!Number.isInteger(t) || t < 1 || t > MAX_REPEAT_TIMES) {
      throw bad(`repeat.times 必须是 1..${MAX_REPEAT_TIMES} 的整数，收到 ${String(t)}`);
    }
    if (!Array.isArray(a.actions) || a.actions.length === 0) throw bad('repeat.actions 不能为空');
    // 嵌套一层就能把 10×10 变成 100 步，两层 1000。不给这条路。
    if (a.actions.some(isRepeat)) throw bad('repeat 不允许嵌套');
    steps += t * a.actions.length;
  }
  if (steps > MAX_STEPS) throw bad(`展开后有 ${steps} 个动作，超过上限 ${MAX_STEPS}`);
}

export function flattenActions(actions: Action[]): FlatStep[] {
  const out: FlatStep[] = [];
  for (const a of actions) {
    if (!isRepeat(a)) {
      out.push({ action: a, label: `第 ${out.length + 1} 个动作` });
      continue;
    }
    for (let round = 1; round <= a.times; round++) {
      a.actions.forEach((inner, i) => {
        out.push({ action: inner as FlatStep['action'], label: `第 ${round} 轮第 ${i + 1} 个动作` });
      });
    }
  }
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
 */
export function resolveTarget(spec: TargetSpec, snapshot: AxSnapshot | null): ResolvedTarget {
  if ('selector' in spec) {
    if (typeof spec.selector !== 'string' || spec.selector.trim() === '') throw bad('selector 不能为空');
    return { kind: 'selector', selector: spec.selector };
  }
  if (!snapshot) {
    throw new KydogError('browser.stale_index', '这个标签还没有快照，编号无从解析 —— 先取一份快照');
  }
  if (snapshot.snapshotId !== spec.snapshotId) {
    throw new KydogError('browser.stale_index',
      `编号来自快照 ${spec.snapshotId}，当前快照是 ${snapshot.snapshotId} —— 页面已经变了，重新取一份再操作`);
  }
  const node = snapshot.nodes.find((n) => n.index === spec.index);
  if (!node) {
    throw new KydogError('browser.stale_index', `快照 ${spec.snapshotId} 里没有编号 ${spec.index}`);
  }
  return {
    kind: 'node',
    nodeId: node.nodeId,
    // 点击坐标取元素中心，单位是 CSS px —— CDP 的 Input 事件就吃这个，
    // 按缩放换算过反而打不中（2026-09-08 spike 实测）。
    x: node.x + node.w / 2,
    y: node.y + node.h / 2,
    isPassword: (node as { isPassword?: boolean }).isPassword === true,
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

export function keyEventsFor(key: string): KeyEvent[] {
  const spec = KEYS[key];
  if (!spec) {
    throw bad(`不认识的按键 ${JSON.stringify(key)}，只支持：${Object.keys(KEYS).join(' / ')}`);
  }
  const base = { key, code: spec.code, windowsVirtualKeyCode: spec.vk };
  return [
    { type: 'keyDown', ...base, ...(spec.text ? { text: spec.text } : {}) },
    { type: 'keyUp', ...base },
  ];
}
