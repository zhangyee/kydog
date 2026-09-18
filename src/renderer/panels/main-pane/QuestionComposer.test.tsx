import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { findAllWhere, findOneWhere, type MiniElement, type Mounted } from '../../../test-support/miniReact';
import type { AskQuestion } from '../../../shared/askQuestion';

/**
 * **提问态 composer 的键盘规格。** 这套规格是刻意设计过的：
 *
 *  - 数字键 1..N 选第 N 个选项（单选选中即前进），N+1 把光标送进「其他」输入框 —— 不是选中；
 *  - ←→ 翻题，Esc 等同 ×（结束提问）；
 *  - **Enter 什么都不做**：用户正在框里写想法时一个回车就跳走太危险，前进与提交只走底部按钮；
 *  - 以上全部只在焦点**不在输入框**时生效：框里数字键就是打字、← 就是移光标。
 *
 * 真身是根节点上的 `onKeyDown`：键盘事件从输入框冒泡上来时 `e.target` 是那个 input，
 * 组件按 `e.target instanceof HTMLInputElement` 分流。node 环境没有 DOM，这里把
 * `HTMLInputElement` 换成一个本地的类，「焦点在框里」就是 target 为它的实例。
 *
 * 守不住的（仍要 e2e）：真实的焦点移动与事件冒泡、按键真的打进输入框里的字。
 * 「其他」输入框的 ref 挂在子组件 `QuestionCustomRow` 里（miniReact 不展开子组件），
 * 所以这里替它把 `inputRef.current` 接上一个带 `focus` 计数的假元素 —— 真 React 下这一步由
 * `<input ref={inputRef}>` 完成。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

// 只把 React 订阅那一层换成直读，getState / setState 用真身（同 narrowMode.test.tsx）。
// 直读意味着 store 变了组件不会自己重渲染 —— 每按一次键都手动 rerender（见 press）。
vi.mock('../../stores/askStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/askStore')>();
  const real = mod.useAskStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useAskStore: hook };
});

const { mount } = await import('../../../test-support/miniReact');
const { QuestionComposer } = await import('./QuestionComposer');
const { QuestionOptionRow, QuestionCustomRow } = await import('./QuestionOptionRow');
const { useAskStore } = await import('../../stores/askStore');

const TID = 'thr-1';
const TCID = 'ask-1';

/** 与 e2e 夹具 ask-user-question.json 同形：单选 / 多选 / 单选。 */
const THREE: AskQuestion[] = [
  {
    id: 'q0', question: '这次改动落在哪个分支上？', header: '分支',
    options: [
      { id: 'q0o0', label: '当前 worktree', description: '继续留在这个隔离分支上。', recommended: true },
      { id: 'q0o1', label: '新开一个 worktree', description: '跟当前改动完全隔离。' },
    ],
  },
  {
    id: 'q1', question: '需要跑哪些验证？', header: '验证', multiSelect: true,
    options: [
      { id: 'q1o0', label: 'tsc', description: '类型检查。' },
      { id: 'q1o1', label: 'vitest', description: '单元测试。' },
    ],
  },
  {
    id: 'q2', question: '完成后怎么交付？', header: '交付',
    options: [
      { id: 'q2o0', label: '开 PR', description: '走评审流程。' },
      { id: 'q2o1', label: '直接推', description: '小改动直接落。' },
    ],
  },
];

/** 单题 8 个选项：锁住「选项上限为什么是 8」—— 1..8 选选项，第 9 位留给「其他」。 */
const EIGHT: AskQuestion[] = [{
  id: 'q0', question: '这次改动最像下面哪一种？', header: '分类',
  options: ['新功能', '修复', '重构', '文档', '测试', '性能', '依赖升级', '杂项']
    .map((label, i) => ({ id: `q0o${String(i)}`, label, description: `${label}。` })),
}];

/** 本地的 HTMLInputElement：`instanceof` 认它，就是「焦点在输入框里」。 */
class FakeInput {}

let invokes: Array<{ method: string; args: unknown }> = [];
let focusCustom: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokes = [];
  useAskStore.setState({ pendingByThread: {}, draftByThread: {} });
  (globalThis as unknown as { HTMLInputElement: unknown }).HTMLInputElement = FakeInput;
  (globalThis as unknown as { window: unknown }).window = {
    kydog: {
      invoke: (method: string, args?: unknown) => { invokes.push({ method, args }); return Promise.resolve(undefined); },
    },
  };
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).window;
  delete (globalThis as unknown as Record<string, unknown>).HTMLInputElement;
});

type M = Mounted<{ threadId: string }>;

function open(questions: AskQuestion[]): M {
  useAskStore.getState().open(TID, TCID, questions);
  const m = mount(QuestionComposer, { threadId: TID });
  // 替 QuestionCustomRow 把 input 接到 inputRef 上（真 React 下是 <input ref={inputRef}>）
  focusCustom = vi.fn();
  const customRow = findOneWhere(m.tree, (el) => el.type === QuestionCustomRow);
  (customRow.props.inputRef as { current: unknown }).current = { focus: focusCustom };
  return m;
}

const draft = () => {
  const d = useAskStore.getState().draftByThread[TID];
  if (!d) throw new Error('草稿不在了');
  return d;
};
const picked = (qid: string) => {
  const cur = draft().byQuestionId[qid];
  return cur?.kind === 'answered' ? cur.optionIds : cur?.kind ?? 'unhandled';
};
/** 当前这一题每个选项行的 selected，按渲染次序。 */
const selectedRows = (m: M) => findAllWhere(m.tree, (el) => el.type === QuestionOptionRow).map((el) => el.props.selected as boolean);

/**
 * 在根节点上按一个键。`inInput` 为真时 target 是输入框（事件从框里冒泡上来）。
 * 返回 preventDefault 被调了没有 —— 框里的键**不许**被拦，否则打不进字。
 */
function press(m: M, key: string, opts: { inInput?: boolean } = {}): boolean {
  const root = m.find('question-composer');
  let prevented = false;
  const target = opts.inInput ? new FakeInput() : {};
  (root.props.onKeyDown as (e: unknown) => void)({ key, target, preventDefault: () => { prevented = true; } });
  m.rerender({ threadId: TID });
  return prevented;
}

const click = (el: MiniElement) => { (el.props.onClick as () => void)(); };

describe('提问态：数字键', () => {
  it('单选按 1 等同点第一项：选中并前进；翻回去看得到那一项亮着', () => {
    const m = open(THREE);
    expect(draft().cursor).toBe(0);

    expect(press(m, '1')).toBe(true);
    expect(picked('q0')).toEqual(['q0o0']);
    expect(draft().cursor).toBe(1);

    press(m, 'ArrowLeft');
    expect(draft().cursor).toBe(0);
    expect(selectedRows(m)).toEqual([true, false]);
  });

  it('按 2 选的是第二项，不是第一项（序号不是差一）', () => {
    const m = open(THREE);
    press(m, '2');
    expect(picked('q0')).toEqual(['q0o1']);
  });

  it('N+1 把光标送进「其他」输入框，不选中任何东西；多选下数字键勾选后停在原地', () => {
    const m = open(THREE);
    press(m, '1');                       // 第 1 题，前进到多选的第 2 题
    expect(draft().cursor).toBe(1);

    expect(press(m, '3')).toBe(true);    // 2 个选项 → 3 是「其他」
    expect(focusCustom).toHaveBeenCalledTimes(1);
    expect(picked('q1')).toBe('unhandled');

    press(m, '1');
    press(m, '2');
    expect(picked('q1')).toEqual(['q1o0', 'q1o1']);
    expect(draft().cursor).toBe(1);
    expect(focusCustom).toHaveBeenCalledTimes(1);
  });

  it('8 个选项：8 选中第 8 项且只有它，9 聚焦「其他」而不动选中', () => {
    const m = open(EIGHT);
    expect(selectedRows(m)).toHaveLength(8);
    // 「其他」行排在第 9 位（它的前导序号是 index + 1）
    expect(findOneWhere(m.tree, (el) => el.type === QuestionCustomRow).props.index).toBe(8);

    press(m, '8');
    expect(picked('q0')).toEqual(['q0o7']);
    expect(selectedRows(m)).toEqual([false, false, false, false, false, false, false, true]);
    expect(focusCustom).not.toHaveBeenCalled();

    expect(press(m, '9')).toBe(true);
    expect(focusCustom).toHaveBeenCalledTimes(1);
    expect(picked('q0')).toEqual(['q0o7']);
  });
});

describe('提问态：焦点在输入框里时快捷键一律让路', () => {
  it('数字键、←、Esc 在框里都不起作用也不拦默认行为；同样的键在框外才生效', () => {
    const m = open(THREE);
    press(m, '1');
    expect(draft().cursor).toBe(1);
    const before = draft();

    // 框里：数字就是打字、← 就是移光标、Esc 不关提问 —— 草稿一个字不变，默认行为不拦
    expect(press(m, '1', { inInput: true })).toBe(false);
    expect(press(m, '2', { inInput: true })).toBe(false);
    expect(press(m, '3', { inInput: true })).toBe(false);
    expect(press(m, 'ArrowLeft', { inInput: true })).toBe(false);
    expect(press(m, 'ArrowRight', { inInput: true })).toBe(false);
    expect(press(m, 'Escape', { inInput: true })).toBe(false);
    expect(draft()).toBe(before);
    expect(focusCustom).not.toHaveBeenCalled();
    expect(invokes).toEqual([]);

    // 框外：同样的键都生效（正向对照 —— 证明上面的「不变」不是按键根本没送到）
    expect(press(m, 'ArrowRight')).toBe(true);
    expect(draft().cursor).toBe(2);
    expect(press(m, 'ArrowLeft')).toBe(true);
    expect(draft().cursor).toBe(1);
    press(m, '1');
    expect(picked('q1')).toEqual(['q1o0']);
    press(m, '3');
    expect(focusCustom).toHaveBeenCalledTimes(1);
    expect(press(m, 'Escape')).toBe(true);
    expect(invokes).toEqual([{ method: 'ask.cancel', args: { threadId: TID, toolCallId: TCID } }]);
  });
});

describe('提问态：Enter 不提交也不前进', () => {
  it('全部题都有终态、主按钮写着「提交」时，框内框外按 Enter 都原地不动；点按钮才提交', () => {
    const m = open(THREE);
    press(m, '1');                                  // 第 1 题答了，到第 2 题
    click(m.find('ask-skip'));                      // 第 2 题跳过，到第 3 题
    m.rerender({ threadId: TID });
    click(m.find('ask-skip'));                      // 第 3 题跳过（最后一题，停在原地）
    m.rerender({ threadId: TID });
    // 前提：已经是「能提交」的状态 —— 否则 Enter 接到 onSubmit 上也只是跳到缺口，看不出来
    expect(m.find('ask-submit').props.children).toBe('提交');
    // 退回中间一题：Enter 若被接成「下一题」，cursor 会动
    press(m, 'ArrowLeft');
    expect(draft().cursor).toBe(1);
    const before = draft();

    press(m, 'Enter');
    press(m, 'Enter', { inInput: true });
    expect(draft()).toBe(before);
    expect(invokes).toEqual([]);

    // 正向对照：提交这条路本身是通的，走的是底部按钮
    click(m.find('ask-submit'));
    expect(invokes.map((c) => c.method)).toEqual(['ask.submit']);
  });
});

describe('提问态：Esc 等同 ×', () => {
  it('Esc 与点 × 发出的是同一条 ask.cancel', () => {
    const m = open(THREE);
    click(m.find('ask-close'));
    expect(press(m, 'Escape')).toBe(true);
    const cancel = { method: 'ask.cancel', args: { threadId: TID, toolCallId: TCID } };
    expect(invokes).toEqual([cancel, cancel]);
  });
});
