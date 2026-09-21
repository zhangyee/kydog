import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, findOneWhere, findAllWhere, findByTestId, queryByTestId } from '../../../test-support/miniReact';

/**
 * **对话栏窄模式（Task 5）**：浏览器侧栏开着时，对话栏收窄——模型 pill 收起来、
 * 面包屑整行不渲染、正文左右边距从 48 收到 20。三处判据都是同一个
 * `useUiStore((s) => s.browserOpen)`，不是各自按宽度算阈值。
 *
 * 三个被测组件（`Composer` / `ThreadView` / `MessageList`）都真的挂载一遍
 * （miniReact，见文件顶部 `vi.mock('react', …)`），断言的是渲染出来的树，不是
 * 「某个函数被调用过」。子组件在 miniReact 里不展开——`ComposerActionsRow` /
 * `ThreadBreadcrumb` 这类只是树上的一个 `{ type, props }` 节点，所以：
 *
 *  - 模型 pill 在 `ComposerActionsRow` 的 `right` prop 里，不在它的
 *    `children`——miniReact 的 `walk()` 只顺 `children` 往下走，够不到 `right`
 *    这类自定义 prop。所以要先按身份（`el.type === ComposerActionsRow`）找到
 *    这个节点，再从它的 `props.right` 里单独 `queryByTestId`，而不是直接对
 *    整棵树 `find('model-pill')`。
 *  - `ThreadBreadcrumb` 同理：判「这行渲染没渲染」按 `el.type ===
 *    ThreadBreadcrumb` 在树里找不找得到，不看它内部输出了什么字。
 *
 * `MessageList` 还有一处环境限制：它用 `useAutoScroll` 在 ref 指向的元素上挂
 * `addEventListener('scroll', …)`，而 miniReact 的假 ref 元素只有
 * `getBoundingClientRect` 一个方法——真的跑这个 effect 会当场抛
 * `addEventListener is not a function`。这里把 `./useAutoScroll` 整个换成
 * no-op：这份用例只关心 padding 这个渲染结果，不关心自动滚动行为。
 *
 * 每一条正向断言都配一条反向对照（浏览器关着时的样子），包括 Step 1 代码块里
 * 没列出来的面包屑那一条——只测「开着不渲染」的话，「面包屑整行被删掉」这种
 * 改法也会让它绿。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

// useAutoScroll 挂在 scrollRef 上的 effect 需要真实 DOM 的 addEventListener，
// miniReact 的假元素没有这个方法。这份用例不测滚动行为，整个换成 no-op。
vi.mock('./useAutoScroll', () => ({ useAutoScroll: () => {} }));

// 下面几个 store 都是同一套替身：**只把 React 订阅那一层换成直读**，
// getState / setState / subscribe 全用真身——`beforeEach` 里 setState 摆的
// 状态，组件里的 `useXxxStore(selector)` 立刻读得到。真的 zustand hook 在
// 这个没有真 React 渲染器的环境里会摸到 null 的 dispatcher 崩掉（同一件事，
// 见 BrowserSidebar.test.tsx / ThreeColumnLayout.test.tsx 顶部的注释），
// 所以三个组件用到的 store 都要照这个模式换一遍，不能只换 uiStore。

vi.mock('../../stores/uiStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/uiStore')>();
  const real = mod.useUiStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useUiStore: hook };
});

vi.mock('../../stores/threadsStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/threadsStore')>();
  const real = mod.useThreadsStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useThreadsStore: hook };
});

vi.mock('../../stores/runsStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/runsStore')>();
  const real = mod.useRunsStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useRunsStore: hook };
});

vi.mock('../../stores/llmStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/llmStore')>();
  const real = mod.useLlmStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useLlmStore: hook };
});

vi.mock('../../stores/skillsStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/skillsStore')>();
  const real = mod.useSkillsStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useSkillsStore: hook };
});

vi.mock('../../stores/askStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/askStore')>();
  const real = mod.useAskStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useAskStore: hook };
});

vi.mock('../../stores/identityStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/identityStore')>();
  const real = mod.useIdentityStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useIdentityStore: hook };
});

vi.mock('./composerDraftStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./composerDraftStore')>();
  const real = mod.useComposerDraftStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useComposerDraftStore: hook };
});

vi.mock('../../stores/fileIndexStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/fileIndexStore')>();
  const real = mod.useFileIndexStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useFileIndexStore: hook };
});

const { Composer } = await import('./Composer');
const { ComposerActionsRow } = await import('./ComposerActionsRow');
const { ThreadView } = await import('./ThreadView');
const { ThreadBreadcrumb } = await import('./ThreadBreadcrumb');
const { MessageList } = await import('./MessageList');
const { NewThreadEmptyState } = await import('./NewThreadEmptyState');
const { useUiStore } = await import('../../stores/uiStore');
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useRunsStore } = await import('../../stores/runsStore');
const { useLlmStore } = await import('../../stores/llmStore');
const { useSkillsStore } = await import('../../stores/skillsStore');
const { useAskStore } = await import('../../stores/askStore');
const { useIdentityStore } = await import('../../stores/identityStore');
const { useComposerDraftStore } = await import('./composerDraftStore');
const { useFileIndexStore } = await import('../../stores/fileIndexStore');

beforeEach(() => {
  useUiStore.setState(useUiStore.getInitialState());
  useThreadsStore.setState(useThreadsStore.getInitialState());
  useRunsStore.setState(useRunsStore.getInitialState());
  useLlmStore.setState(useLlmStore.getInitialState());
  useSkillsStore.setState(useSkillsStore.getInitialState());
  useAskStore.setState(useAskStore.getInitialState());
  useIdentityStore.setState(useIdentityStore.getInitialState());
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState());
  useFileIndexStore.setState(useFileIndexStore.getInitialState());
});

/** 模型 pill 在 `ComposerActionsRow` 的 `right` prop 里，见文件头注释。 */
function findModelPill(tree: unknown) {
  const row = findOneWhere(tree, (el) => el.type === ComposerActionsRow);
  return queryByTestId(row.props.right, 'model-pill');
}

describe('Composer：模型 pill 收在窄模式里', () => {
  // `findModelPill` 内层用的是 `queryByTestId`——找不到就返回 null，不抛错。
  // 单独写「开着 → 不渲染」断言 `toBeNull()`，会有两个让它为真的原因：① pill 真的没
  // 渲染（要守的）；② 查找本身坏了（比如 `data-testid="model-pill"` 被改名，
  // `queryByTestId` 一样返回 null）。受控变异证实过：只改那个字符串，这条断言照样绿，
  // 得靠隔壁「关着 → 在」那条独立用例才会红——假绿被反向对照兜住，不是被这条断言自己
  // 拆穿。这里把「查找找得到」的前置断言收进同一条用例：先以关着渲染一次、断言找得到
  // pill，再切成开着渲染、断言找不到——`data-testid` 被改名时，第一步就会红，不用等
  // 隔壁那条。
  it('浏览器开着 → 模型 pill 不渲染（先证明关着时查得到，堵住 queryByTestId 找不到就返回 null 的假绿）', () => {
    useUiStore.setState({ browserOpen: false });
    const closed = mount(Composer, { threadId: 't1' });
    expect(findModelPill(closed.tree)).not.toBeNull();

    useUiStore.setState({ browserOpen: true });
    const opened = mount(Composer, { threadId: 't1' });
    expect(findModelPill(opened.tree)).toBeNull();
  });

  it('浏览器关着 → 模型 pill 在（反向对照：没有这条，「pill 被彻底删掉」也会让上一条绿）', () => {
    useUiStore.setState({ browserOpen: false });
    const m = mount(Composer, { threadId: 't1' });
    expect(findModelPill(m.tree)).not.toBeNull();
  });
});

describe('ThreadView：面包屑整行收在窄模式里', () => {
  it('浏览器开着 → 面包屑整行不渲染', () => {
    useUiStore.setState({ browserOpen: true });
    useThreadsStore.setState({ historyByThread: { t1: [] } });
    const m = mount(ThreadView, { threadId: 't1' });
    expect(findAllWhere(m.tree, (el) => el.type === ThreadBreadcrumb)).toHaveLength(0);
  });

  it('浏览器关着 → 面包屑整行在（反向对照：Step 1 的清单里没列这条，但道理和 pill 那条一样——补上，免得「整行被删掉」也能让上一条绿）', () => {
    useUiStore.setState({ browserOpen: false });
    useThreadsStore.setState({ historyByThread: { t1: [] } });
    const m = mount(ThreadView, { threadId: 't1' });
    expect(findAllWhere(m.tree, (el) => el.type === ThreadBreadcrumb)).toHaveLength(1);
  });
});

describe('MessageList：正文左右边距跟着窄模式收窄', () => {
  function messageListPadding(browserOpen: boolean): string {
    useUiStore.setState({ browserOpen });
    useThreadsStore.setState({ historyByThread: { t1: [] } });
    const m = mount(MessageList, { threadId: 't1' });
    const outer = findByTestId(m.tree, 'message-list');
    const inner = outer.props.children as { props: { style: { padding: string } } };
    return inner.props.style.padding;
  }

  it('浏览器开着 → 正文左右边距收到 20', () => {
    expect(messageListPadding(true)).toBe('32px 20px 80px');
  });

  it('浏览器关着 → 正文左右边距还是 48', () => {
    expect(messageListPadding(false)).toBe('32px 48px 80px');
  });
});

/**
 * I-2（终评发现）：新建对话首屏（`NewThreadEmptyState`）原先四样收窄清单里没有它，
 * 但目标是「给对话栏腾出来的横向空间不被留白吃掉」——这个入口漏了，360px 对话栏里
 * 横向 padding 80 两边吃掉 160，内容盒只剩 200。判据与另外三处逐字相同：
 * `useUiStore((s) => s.browserOpen)`。
 */
describe('NewThreadEmptyState：首屏留白跟着窄模式收窄', () => {
  function emptyStatePadding(browserOpen: boolean): string {
    useUiStore.setState({ browserOpen });
    useSkillsStore.setState({ skills: [] });
    const m = mount(NewThreadEmptyState, { threadId: 't1' });
    const outer = findByTestId(m.tree, 'new-thread-empty-state');
    const inner = outer.props.children as { props: { style: { padding: string } } };
    return inner.props.style.padding;
  }

  it('浏览器开着 → 首屏留白收到 20（先证明关着时是 80，堵住「整段留白被删掉」也能让这条绿）', () => {
    expect(emptyStatePadding(false)).toBe('64px 80px');
    expect(emptyStatePadding(true)).toBe('64px 20px');
  });

  it('浏览器关着 → 首屏留白还是 80', () => {
    expect(emptyStatePadding(false)).toBe('64px 80px');
  });
});
