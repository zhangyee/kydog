import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type MiniElement, type Mounted } from '../../../test-support/miniReact';

/**
 * **侧栏两处就地重命名框：窗口整体失焦不算「编辑结束」。**
 *
 * 切到别的应用时，浏览器同样会在输入框上派发 blur（它仍是 activeElement，只是
 * `document.hasFocus()` 变成 false）。把这当成提交，用户切走再切回来编辑框就没了。
 * `ThreadRow` / `ProjectRow` 的 onBlur 都先问 `isWindowBlur()`，窗口失焦就原样留着。
 *
 * 替代 e2e/34-thread-rename「切走再切回来，重命名框和已输入内容都还在」。那条 e2e 也是
 * 把 `document.hasFocus` 打桩成 false 再触发 blur —— 这个前置条件在 e2e 里同样造不出来。
 * 它比这里多守的只有「真实 blur 走 React 合成事件到得了 onBlur」，那是 React 自己的事。
 * `ProjectRow` 的同一道闸此前没有任何用例。
 *
 * 每条用例两个方向都走：先窗口失焦（框还在、字还在、没发 RPC），再在同一个框上做一次
 * 普通失焦（框收起、RPC 带着新名字发出去）—— 后一半证明「框还在」不是因为 blur 这条线
 * 根本没接上、或者查找本身坏了。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  // miniReact 的假元素只有 focus / blur，没有 select()；两个组件进入重命名态时的 effect
  // 会调 `inputRef.current?.select()`。在 ref 挂上元素的那一刻补一个空操作的 select。
  const useRef = <T,>(init: T): { current: T } => {
    const ref = mini.miniUseRef(init);
    if (Object.getOwnPropertyDescriptor(ref, 'current')?.set === undefined) {
      let v = ref.current;
      Object.defineProperty(ref, 'current', {
        get: () => v,
        set: (next: T) => {
          if (typeof next === 'object' && next !== null && !('select' in next)) Object.assign(next, { select: () => {} });
          v = next;
        },
      });
    }
    return ref;
  };
  return { ...real, ...mini.reactHooks, useRef } as unknown as typeof real;
});

// 只把 React 订阅那一层换成直读，getState / setState 用真身（同 narrowMode.test.tsx）。
vi.mock('../../stores/threadsStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/threadsStore')>();
  const real = mod.useThreadsStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useThreadsStore: hook };
});

vi.mock('../../stores/uiStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/uiStore')>();
  const real = mod.useUiStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useUiStore: hook };
});

const { ThreadRow } = await import('./ThreadRow');
const { ProjectRow } = await import('./ProjectRow');
const { useThreadsStore } = await import('../../stores/threadsStore');

const PROJECT_PATH = '/tmp/proj-rn';
const BASE = 'proj-rn';
const THREAD = {
  id: 'dddddddd-2222-2222-2222-222222222222',
  projectPath: PROJECT_PATH,
  title: '旧名字',
  createdAt: '2026-09-18T00:00:00Z',
  lastActiveAt: '2026-09-18T00:00:00Z',
};
const PROJECT = { path: PROJECT_PATH, addedAt: '2026-09-18T00:00:00Z' };

type Call = { method: string; args: Record<string, unknown> };
const calls: Call[] = [];
/** `document.hasFocus()` 的返回值：false = 整个窗口失焦了（切到了别的应用）。 */
let windowFocused = true;

beforeEach(() => {
  calls.length = 0;
  windowFocused = true;
  useThreadsStore.setState({
    ...useThreadsStore.getInitialState(),
    projects: [PROJECT],
    threadsByProject: { [PROJECT_PATH]: [THREAD] },
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { hasFocus: () => windowFocused };
  g.window = {
    kydog: {
      invoke: (method: string, args: Record<string, unknown>) => {
        calls.push({ method, args });
        if (method === 'thread.update') return Promise.resolve({ ...THREAD, ...args, id: THREAD.id });
        if (method === 'project.update') return Promise.resolve({ ...PROJECT, label: args.label });
        return Promise.reject(new Error(`没接这条 RPC：${method}`));
      },
    },
  };
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.document;
  delete g.window;
});

function type(input: MiniElement, value: string): void {
  (input.props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
}

function blur(input: MiniElement): void {
  (input.props.onBlur as () => void)();
}

describe('ThreadRow：重命名框遇到窗口失焦', () => {
  const inputId = `thread-rename-input-${THREAD.id}`;

  function renaming(): Mounted<{ thread: typeof THREAD }> {
    const m = mount(ThreadRow, { thread: THREAD });
    expect(m.query(inputId)).toBeNull();
    (m.find(`thread-rename-${THREAD.id}`).props.onClick as () => void)();
    return m;
  }

  it('窗口失焦 → 框和已输入的内容都还在、不提交；随后普通失焦 → 提交并收起', async () => {
    const m = renaming();
    type(m.find(inputId), '改到一半');
    // 前提：输入的内容与原标题不同（相同的话 commitRename 本来就不发 RPC）
    expect(m.find(inputId).props.value).toBe('改到一半');

    windowFocused = false;
    blur(m.find(inputId));
    await m.settle();
    expect(m.query(inputId)).not.toBeNull();
    expect(m.find(inputId).props.value).toBe('改到一半');
    expect(calls).toEqual([]);

    // 反向：窗口回来了，焦点移到应用内别处 —— 这就是编辑结束，照常提交
    windowFocused = true;
    type(m.find(inputId), '新名字');
    blur(m.find(inputId));
    await m.settle();
    expect(m.query(inputId)).toBeNull();
    expect(calls).toEqual([{ method: 'thread.update', args: { threadId: THREAD.id, title: '新名字' } }]);
    expect(useThreadsStore.getState().threadsByProject[PROJECT_PATH]?.[0]?.title).toBe('新名字');
  });
});

describe('ProjectRow：重命名框遇到窗口失焦', () => {
  const inputId = `project-rename-input-${BASE}`;
  type P = { project: typeof PROJECT; expanded: boolean; onToggleExpand: () => void };

  function renaming(): Mounted<P> {
    const m = mount(ProjectRow, { project: PROJECT, expanded: false, onToggleExpand: () => {} });
    expect(m.query(inputId)).toBeNull();
    (m.find(`project-rename-${BASE}`).props.onClick as () => void)();
    return m;
  }

  it('窗口失焦 → 框和已输入的内容都还在、不提交；随后普通失焦 → 提交并收起', async () => {
    const m = renaming();
    type(m.find(inputId), '改到一半');
    // 前提：输入的内容与原名（目录名）不同
    expect(m.find(inputId).props.value).toBe('改到一半');

    windowFocused = false;
    blur(m.find(inputId));
    await m.settle();
    expect(m.query(inputId)).not.toBeNull();
    expect(m.find(inputId).props.value).toBe('改到一半');
    expect(calls).toEqual([]);

    windowFocused = true;
    type(m.find(inputId), '新名字');
    blur(m.find(inputId));
    await m.settle();
    expect(m.query(inputId)).toBeNull();
    expect(calls).toEqual([{ method: 'project.update', args: { projectPath: PROJECT_PATH, label: '新名字' } }]);
    expect(useThreadsStore.getState().projects[0]?.label).toBe('新名字');
  });
});
