import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, findAllWhere, walk, type MiniElement } from '../../../test-support/miniReact';
import type { MentionEntry, MentionView } from './mentionSearch';

/**
 * @ 触发行内引用（spec §3.5 v2）—— Composer 把光标处的查询词交给一次弹出的会话（`mentionSearch`），
 * 列表开着才有会话、关掉 / 换项目 / 卸载就 dispose；会话报上来的视图接到列表上；键盘在列表开着时
 * 归列表：文件插标签、文件夹进入下一层。照 `Composer.attachments.test.tsx` 的模式：`vi.mock('react')`
 * 换 miniReact 的 hooks；组件用到的每个 zustand store 都换成「直读 getState」的替身；子组件不展开，
 * 按 `el.type === 子组件` 在树里找 props。会话本身（读目录、排序）由 `mentionSearch.test.ts` 守，
 * 这里把 `createMentionSession` 换成记录调用的替身，由用例自己调 `onChange` 报视图。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

function directRead<M extends Record<string, unknown>>(mod: M, key: keyof M & string): M {
  const real = mod[key] as unknown as { getState: () => unknown };
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as M[typeof key];
  Object.assign(hook as object, real);
  return { ...mod, [key]: hook };
}

type FakeSession = {
  opts: { projectPath: string; readDir: (p: string) => Promise<unknown>; onChange: (v: MentionView) => void };
  setQuery: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
};
const sessions = vi.hoisted(() => [] as FakeSession[]);
/** 用例可以让替身在 setQuery 里当场报视图（真会话读过的内容就是当场出结果）。 */
const fakeHooks = vi.hoisted(() => ({ onSetQuery: null as null | ((s: FakeSession, q: string) => void) }));

vi.mock('../../stores/uiStore', async (orig) => directRead(await orig<typeof import('../../stores/uiStore')>(), 'useUiStore'));
vi.mock('../../stores/threadsStore', async (orig) => directRead(await orig<typeof import('../../stores/threadsStore')>(), 'useThreadsStore'));
vi.mock('../../stores/runsStore', async (orig) => directRead(await orig<typeof import('../../stores/runsStore')>(), 'useRunsStore'));
vi.mock('../../stores/llmStore', async (orig) => directRead(await orig<typeof import('../../stores/llmStore')>(), 'useLlmStore'));
vi.mock('../../stores/skillsStore', async (orig) => directRead(await orig<typeof import('../../stores/skillsStore')>(), 'useSkillsStore'));
vi.mock('./composerDraftStore', async (orig) => directRead(await orig<typeof import('./composerDraftStore')>(), 'useComposerDraftStore'));
vi.mock('./mentionSearch', async (orig) => ({
  ...(await orig<typeof import('./mentionSearch')>()),
  createMentionSession: (opts: FakeSession['opts']) => {
    const s: FakeSession = { opts, setQuery: vi.fn((q: string) => { fakeHooks.onSetQuery?.(s, q); }), dispose: vi.fn() };
    sessions.push(s);
    return s;
  },
}));

const { Composer } = await import('./Composer');
const { ComposerEditor } = await import('./ComposerEditor');
const { ComposerMentionMenu } = await import('./ComposerMentionMenu');
const { NavIcon } = await import('../../shared');
const { useComposerDraftStore } = await import('./composerDraftStore');
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useLlmStore } = await import('../../stores/llmStore');

const PROJ = '/proj';
const PROJ2 = '/other';
const THREAD = { id: 't1', projectPath: PROJ, title: 'x', createdAt: 'x', lastActiveAt: 'x' };

function entry(providerId: string, modelIds: string[], imageInputModelIds: string[]) {
  return { providerId, displayName: providerId, kind: 'apiKey' as const, authStatus: { configured: true }, modelIds, imageInputModelIds, defaultModel: modelIds[0] };
}
function useModel(providerId: string, modelId: string, imageOk: boolean) {
  useLlmStore.setState({
    configured: [entry(providerId, [modelId], imageOk ? [modelId] : [])] as never,
    defaultProvider: providerId as never, defaultModel: modelId,
  });
}
function editor(tree: unknown) {
  return findAllWhere(tree as never, (el) => el.type === ComposerEditor)[0];
}
function menu(tree: unknown) {
  return findAllWhere(tree as never, (el) => el.type === ComposerMentionMenu);
}

const file = (rel: string): MentionEntry => ({ rel, name: rel.slice(rel.lastIndexOf('/') + 1), kind: 'file', depth: rel.split('/').length - 1 });
const dir = (rel: string): MentionEntry => ({ ...file(rel), kind: 'dir' });
const view = (items: MentionEntry[], done: boolean, mode: MentionView['mode'] = 'name'): MentionView => ({ mode, items, done });

function keyEv(key: string, mods: { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean; isComposing?: boolean } = {}) {
  return {
    key, shiftKey: mods.shiftKey ?? false, metaKey: mods.metaKey ?? false, ctrlKey: mods.ctrlKey ?? false,
    nativeEvent: { isComposing: mods.isComposing ?? false }, preventDefault: vi.fn(),
  };
}
/** 编辑器的 handle：miniReact 不展开 ComposerEditor，ref 由用例自己挂一个替身（React 19 的 ref 就在 props 上）。 */
function installHandle(tree: unknown) {
  const h = { focus: vi.fn(), rootEl: () => null, insertMention: vi.fn(), replaceMentionQuery: vi.fn(), dismissMention: vi.fn() };
  (editor(tree).props.ref as { current: unknown }).current = h;
  return h;
}
const sendCalls = () => invoke.mock.calls.filter((c) => c[0] === 'thread.send');

let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sessions.length = 0;
  fakeHooks.onSetQuery = null;
  invoke = vi.fn().mockResolvedValue({ runId: 'r' });
  (globalThis as any).window = { kydog: { invoke, on: () => () => {}, pathForFile: () => '', platform: 'darwin' }, innerHeight: 800, innerWidth: 1200 };
  useThreadsStore.setState({ threadsByProject: { [PROJ]: [THREAD] } as never, historyByThread: { t1: [{ id: 'm0', role: 'user', content: 'x', createdAt: 'x' }] } });
  useComposerDraftStore.setState({ byThread: {} });
  useModel('anthropic', 'claude-sonnet-4-5', true);
});

describe('Composer —— @ 列表的会话', () => {
  it('打出 @dp：按对话的项目建一个会话，readDir 走 project.readDir；接着打 @dpo 还是同一个会话；第一次视图回来之前不渲染列表', async () => {
    const m = mount(Composer, { threadId: 't1' });
    editor(m.tree).props.onMentionQuery('dp');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].opts.projectPath).toBe(PROJ);
    expect(sessions[0].setQuery).toHaveBeenLastCalledWith('dp');

    const nodes = [{ name: 'dpo-2023.pdf', path: '/proj/refs/dpo-2023.pdf', kind: 'file' }];
    invoke.mockResolvedValueOnce(nodes);
    await expect(sessions[0].opts.readDir('/proj/refs')).resolves.toBe(nodes);
    expect(invoke).toHaveBeenLastCalledWith('project.readDir', { path: '/proj/refs' });

    // 会话还没报过视图：列表不渲染（下面报了之后它在 —— 同一个 mount 上的正向证明）
    expect(menu(m.tree)).toHaveLength(0);
    sessions[0].opts.onChange(view([file('refs/dpo-2023.pdf')], false));
    expect(menu(m.tree)).toHaveLength(1);
    expect(menu(m.tree)[0].props).toMatchObject({ items: [file('refs/dpo-2023.pdf')], done: false });

    editor(m.tree).props.onMentionQuery('dpo');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].setQuery).toHaveBeenLastCalledWith('dpo');
    expect(sessions[0].dispose).not.toHaveBeenCalled();
    // 列表关掉（null）：dispose —— 上一句「没 dispose」的正向对照
    editor(m.tree).props.onMentionQuery(null);
    expect(sessions[0].dispose).toHaveBeenCalledTimes(1);
  });

  it('关掉后再打开是新的一次：新会话、不带上一次的结果（它自己的第一次视图回来才渲染）', () => {
    const m = mount(Composer, { threadId: 't1' });
    editor(m.tree).props.onMentionQuery('a');
    sessions[0].opts.onChange(view([file('a.md')], true));
    expect(menu(m.tree)).toHaveLength(1);
    expect(menu(m.tree)[0].props.items).toEqual([file('a.md')]);

    editor(m.tree).props.onMentionQuery(null);
    expect(menu(m.tree)).toHaveLength(0);
    expect(sessions[0].dispose).toHaveBeenCalledTimes(1);

    editor(m.tree).props.onMentionQuery('b');
    expect(sessions).toHaveLength(2);
    expect(sessions[1].setQuery).toHaveBeenLastCalledWith('b');
    // 否定：自己的视图还没回来，列表不渲染 —— 不是接着显示上一次的 a.md（正向见上面第一次打开）
    expect(menu(m.tree)).toHaveLength(0);
    sessions[1].opts.onChange(view([], false));
    expect(menu(m.tree)).toHaveLength(1);
    expect(menu(m.tree)[0].props).toMatchObject({ items: [], done: false });
  });

  it('换项目（空对话换到别的项目）：旧会话 dispose、按新项目建会话并带上当前的查询词；卸载时也 dispose', () => {
    const m = mount(Composer, { threadId: 't1' });
    editor(m.tree).props.onMentionQuery('dp');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].opts.projectPath).toBe(PROJ);
    sessions[0].opts.onChange(view([file('dp.md')], true));
    expect(menu(m.tree)).toHaveLength(1);

    useThreadsStore.setState({ threadsByProject: { [PROJ]: [], [PROJ2]: [{ ...THREAD, projectPath: PROJ2 }] } as never });
    m.rerender({ threadId: 't1' });
    expect(sessions[0].dispose).toHaveBeenCalledTimes(1);
    expect(sessions).toHaveLength(2);
    expect(sessions[1].opts.projectPath).toBe(PROJ2);
    expect(sessions[1].setQuery).toHaveBeenLastCalledWith('dp');
    // 旧项目的结果不跟过来：新会话报视图之前列表不渲染
    expect(menu(m.tree)).toHaveLength(0);

    expect(sessions[1].dispose).not.toHaveBeenCalled();
    m.unmount();
    expect(sessions[1].dispose).toHaveBeenCalledTimes(1);
  });

  it('↓/↑ 移动高亮（首尾回绕）；↵ / Tab：文件交给编辑器插标签，文件夹换成「@<目录>/」进入下一层；输入法组字中的 ↵ 不动', () => {
    const m = mount(Composer, { threadId: 't1' });
    const h = installHandle(m.tree);
    editor(m.tree).props.onMentionQuery('re');
    sessions[0].opts.onChange(view([file('README.md'), dir('refs'), file('refs/re.pdf')], false));
    expect(menu(m.tree)[0].props.highlightIndex).toBe(0);

    // 高亮第 0 项（文件）：↵ 插标签
    const enter = keyEv('Enter');
    editor(m.tree).props.onKeyDown(enter);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(h.insertMention).toHaveBeenLastCalledWith('README.md');
    expect(h.replaceMentionQuery).not.toHaveBeenCalled();

    // ↓ 到文件夹：↵ 进入下一层，不插标签
    const down = keyEv('ArrowDown');
    editor(m.tree).props.onKeyDown(down);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(menu(m.tree)[0].props.highlightIndex).toBe(1);
    editor(m.tree).props.onKeyDown(keyEv('Enter'));
    expect(h.replaceMentionQuery).toHaveBeenLastCalledWith('refs/');
    expect(h.insertMention).toHaveBeenCalledTimes(1);
    editor(m.tree).props.onKeyDown(keyEv('Tab'));
    expect(h.replaceMentionQuery).toHaveBeenCalledTimes(2);

    // 回绕：1 → 2 → 0 → 2
    editor(m.tree).props.onKeyDown(keyEv('ArrowDown'));
    editor(m.tree).props.onKeyDown(keyEv('ArrowDown'));
    expect(menu(m.tree)[0].props.highlightIndex).toBe(0);
    editor(m.tree).props.onKeyDown(keyEv('ArrowUp'));
    expect(menu(m.tree)[0].props.highlightIndex).toBe(2);
    editor(m.tree).props.onKeyDown(keyEv('Tab'));
    expect(h.insertMention).toHaveBeenLastCalledWith('refs/re.pdf');
    expect(h.insertMention).toHaveBeenCalledTimes(2);

    // 组字中的 ↵ 是在确认候选词：不插（上面几次是正向证明，同一个 handle、同一份列表）
    editor(m.tree).props.onKeyDown(keyEv('Enter', { isComposing: true }));
    expect(h.insertMention).toHaveBeenCalledTimes(2);
    expect(h.replaceMentionQuery).toHaveBeenCalledTimes(2);

    // 鼠标点：同一套分流
    menu(m.tree)[0].props.onSelect(dir('refs'));
    expect(h.replaceMentionQuery).toHaveBeenLastCalledWith('refs/');
    menu(m.tree)[0].props.onSelect(file('refs/re.pdf'));
    expect(h.insertMention).toHaveBeenCalledTimes(3);
  });

  it('按名字找的结果随读随进：高亮跟着那一项走（前面插进更好的结果也不换人）；换查询词回到第一项', () => {
    const m = mount(Composer, { threadId: 't1' });
    const h = installHandle(m.tree);
    editor(m.tree).props.onMentionQuery('dp');
    sessions[0].opts.onChange(view([file('a/dp1.md'), file('a/dp2.md')], false));
    editor(m.tree).props.onKeyDown(keyEv('ArrowDown'));
    expect(menu(m.tree)[0].props.highlightIndex).toBe(1);

    sessions[0].opts.onChange(view([file('dp0.md'), file('a/dp1.md'), file('a/dp2.md')], false));
    expect(menu(m.tree)[0].props.highlightIndex).toBe(2);
    editor(m.tree).props.onKeyDown(keyEv('Enter'));
    expect(h.insertMention).toHaveBeenLastCalledWith('a/dp2.md');

    editor(m.tree).props.onMentionQuery('dp2');
    sessions[0].opts.onChange(view([file('b/dp2x.md'), file('a/dp2.md')], false));
    expect(menu(m.tree)[0].props.highlightIndex).toBe(0);
  });

  it('第一次出结果就钉住第一项：之后更好的结果插到前面，↵ 选的仍是用户一直看着的那一项', () => {
    const m = mount(Composer, { threadId: 't1' });
    const h = installHandle(m.tree);
    editor(m.tree).props.onMentionQuery('dp');
    sessions[0].opts.onChange(view([], false));
    sessions[0].opts.onChange(view([file('a/dp1.md')], false));
    expect(menu(m.tree)[0].props.highlightIndex).toBe(0);
    sessions[0].opts.onChange(view([file('dp0.md'), file('a/dp1.md')], false));
    expect(menu(m.tree)[0].props.highlightIndex).toBe(1);
    editor(m.tree).props.onKeyDown(keyEv('Enter'));
    expect(h.insertMention).toHaveBeenLastCalledWith('a/dp1.md');
  });

  it('会话在 setQuery 里当场报视图（弹出、接着打字都一样）：高亮照样钉在那一次的第一项上，不被随后的重置清掉', () => {
    fakeHooks.onSetQuery = (s, q) => {
      if (q === 'dp') s.opts.onChange(view([file('a/dp1.md'), file('a/dp2.md')], false));
      if (q === 'dp2') s.opts.onChange(view([file('a/dp2.md')], false));
    };
    const m = mount(Composer, { threadId: 't1' });
    const h = installHandle(m.tree);
    editor(m.tree).props.onMentionQuery('dp');
    expect(menu(m.tree)[0].props.highlightIndex).toBe(0);
    sessions[0].opts.onChange(view([file('dp0.md'), file('a/dp1.md'), file('a/dp2.md')], false));
    expect(menu(m.tree)[0].props.highlightIndex).toBe(1);
    editor(m.tree).props.onKeyDown(keyEv('Enter'));
    expect(h.insertMention).toHaveBeenLastCalledWith('a/dp1.md');

    editor(m.tree).props.onMentionQuery('dp2');
    sessions[0].opts.onChange(view([file('b/dp2x.md'), file('a/dp2.md')], false));
    expect(menu(m.tree)[0].props.highlightIndex).toBe(1);
    editor(m.tree).props.onKeyDown(keyEv('Enter'));
    expect(h.insertMention).toHaveBeenLastCalledWith('a/dp2.md');
  });

  it('名字里有空白或 @ 的文件夹写成 @"<rel>/；引号里往下哪一层都保持引号；会话收到去掉引号的查询词；名字里有 " 的进不去', () => {
    const m = mount(Composer, { threadId: 't1' });
    const h = installHandle(m.tree);
    editor(m.tree).props.onMentionQuery('Rel', false);
    expect(sessions[0].setQuery).toHaveBeenLastCalledWith('Rel');
    sessions[0].opts.onChange(view([dir('Related Work'), dir('refs')], false));
    editor(m.tree).props.onKeyDown(keyEv('Enter'));
    expect(h.replaceMentionQuery).toHaveBeenLastCalledWith('"Related Work/');
    // 对照：同一份列表里不需要引号的名字照旧不带
    editor(m.tree).props.onKeyDown(keyEv('ArrowDown'));
    editor(m.tree).props.onKeyDown(keyEv('Enter'));
    expect(h.replaceMentionQuery).toHaveBeenLastCalledWith('refs/');

    // 编辑器报上来引号里的查询词：会话收到的是去掉引号的文字
    editor(m.tree).props.onMentionQuery('Related Work/', true);
    expect(sessions[0].setQuery).toHaveBeenLastCalledWith('Related Work/');
    sessions[0].opts.onChange(view([dir('Related Work/sub'), file('Related Work/a b.md'), dir('Related Work/say "hi"')], true, 'browse'));
    editor(m.tree).props.onKeyDown(keyEv('Enter'));
    expect(h.replaceMentionQuery).toHaveBeenLastCalledWith('"Related Work/sub/');
    editor(m.tree).props.onKeyDown(keyEv('ArrowDown'));
    editor(m.tree).props.onKeyDown(keyEv('Enter'));
    expect(h.insertMention).toHaveBeenLastCalledWith('Related Work/a b.md');

    // 用户自己打了 @"、路径里没有空白：往下进一层照样保持引号（引号写法由编辑器报上来的 quoted 决定）
    editor(m.tree).props.onMentionQuery('refs/', true);
    sessions[0].opts.onChange(view([dir('refs/old')], true, 'browse'));
    editor(m.tree).props.onKeyDown(keyEv('Enter'));
    expect(h.replaceMentionQuery).toHaveBeenLastCalledWith('"refs/old/');
    // 回到那一层（名字有 " 的那个文件夹在的地方）
    editor(m.tree).props.onMentionQuery('Related Work/', true);
    sessions[0].opts.onChange(view([dir('Related Work/sub'), file('Related Work/a b.md'), dir('Related Work/say "hi"')], true, 'browse'));
    editor(m.tree).props.onKeyDown(keyEv('ArrowDown'));

    // 名字里有 "：写不出能解析回来的查询词 —— ↵ 与点击都什么都不做，列表照旧开着
    const replaced = h.replaceMentionQuery.mock.calls.length;
    editor(m.tree).props.onKeyDown(keyEv('ArrowDown'));
    expect(menu(m.tree)[0].props.highlightIndex).toBe(2);
    editor(m.tree).props.onKeyDown(keyEv('Enter'));
    menu(m.tree)[0].props.onSelect(dir('Related Work/say "hi"'));
    expect(h.replaceMentionQuery.mock.calls.length).toBe(replaced);
    expect(h.insertMention).toHaveBeenCalledTimes(1);
    expect(menu(m.tree)).toHaveLength(1);
  });

  it('Esc：关掉列表，并告诉编辑器这个 @ 是被 Esc 关掉的（编辑器据此不在松开 Esc 时把它重新报上来）', () => {
    const m = mount(Composer, { threadId: 't1' });
    const h = installHandle(m.tree);
    editor(m.tree).props.onMentionQuery('dpo');
    sessions[0].opts.onChange(view([file('refs/dpo-2023.pdf')], true));
    expect(menu(m.tree)).toHaveLength(1); // 正向：Esc 之前列表确实开着

    const esc = keyEv('Escape');
    editor(m.tree).props.onKeyDown(esc);
    expect(esc.preventDefault).toHaveBeenCalled();
    expect(h.dismissMention).toHaveBeenCalledTimes(1);
    expect(menu(m.tree)).toHaveLength(0);
    expect(sessions[0].dispose).toHaveBeenCalledTimes(1);
    expect(h.insertMention).not.toHaveBeenCalled();
    // 「松开 Esc 那一下不再报同一个 @」是编辑器在 DOM 上做的（文本节点 + @ 位置 + 整个 @ 词），
    // 这一层测不到 —— 由 e2e/27-composer.spec.ts「@ 列表：Esc 关掉…」守。
  });

  it('读完且一条都没有：↵ 照常发送（「谢谢@所有人」）；视图没回来 / 还在查找时 ↵ 什么都不做；Tab 始终不发', () => {
    useComposerDraftStore.getState().setDraft('t1', { skill: null, body: '谢谢@所有人' });
    const m = mount(Composer, { threadId: 't1' });
    const h = installHandle(m.tree);
    editor(m.tree).props.onMentionQuery('所有人');

    // 视图还没回来
    editor(m.tree).props.onKeyDown(keyEv('Enter'));
    expect(sendCalls()).toHaveLength(0);
    // 还在往下读、暂时没有结果
    sessions[0].opts.onChange(view([], false));
    expect(menu(m.tree)[0].props).toMatchObject({ items: [], done: false });
    editor(m.tree).props.onKeyDown(keyEv('Enter'));
    expect(sendCalls()).toHaveLength(0);
    // 读完了、没有匹配 —— 按的是 Tab：不发，焦点也不跳走
    sessions[0].opts.onChange(view([], true));
    expect(menu(m.tree)[0].props).toMatchObject({ items: [], done: true });
    const tab = keyEv('Tab');
    editor(m.tree).props.onKeyDown(tab);
    expect(tab.preventDefault).toHaveBeenCalled();
    expect(sendCalls()).toHaveLength(0);
    // 同一个 mount，条件齐了再按 ↵：发出去的就是正文原样（证明上面几次「不发」不是因为它本身发不出去）
    const enter = keyEv('Enter');
    editor(m.tree).props.onKeyDown(enter);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(sendCalls()).toHaveLength(1);
    expect(sendCalls()[0][1]).toMatchObject({ threadId: 't1', content: '谢谢@所有人' });
    expect(h.insertMention).not.toHaveBeenCalled();
  });

  it('读完但有结果：↵ 归列表（插标签），不发送', () => {
    useComposerDraftStore.getState().setDraft('t1', { skill: null, body: '看@a' });
    const m = mount(Composer, { threadId: 't1' });
    const h = installHandle(m.tree);
    editor(m.tree).props.onMentionQuery('a');
    sessions[0].opts.onChange(view([file('a.md')], true));
    editor(m.tree).props.onKeyDown(keyEv('Enter'));
    expect(h.insertMention).toHaveBeenLastCalledWith('a.md');
    expect(sendCalls()).toHaveLength(0);
    // 正向：同一个 mount，列表关掉之后 ↵ 照常发送
    editor(m.tree).props.onMentionQuery(null);
    editor(m.tree).props.onKeyDown(keyEv('Enter'));
    expect(sendCalls()).toHaveLength(1);
  });
});

/** 一棵元素树里的全部文字（子组件不展开）。 */
function textOf(node: unknown): string {
  let out = '';
  const visit = (n: unknown) => {
    if (typeof n === 'string' || typeof n === 'number') { out += String(n); return; }
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (n && typeof n === 'object' && 'props' in n) visit((n as MiniElement).props.children);
  };
  visit(node);
  return out;
}

describe('ComposerMentionMenu', () => {
  const rect = { left: 0, top: 500, width: 300, height: 40 } as DOMRect;
  const props = (items: MentionEntry[], done: boolean) => ({ items, done, highlightIndex: 0, anchorRect: rect, onHover: vi.fn(), onSelect: vi.fn() });

  it('文件夹一行带文件夹图标、名字后面带 /，testid 是 mention-dir-<rel>；文件是 mention-item-<rel>；按下交出整条', () => {
    (globalThis as any).window = { innerHeight: 800 };
    const p = props([dir('refs'), file('refs/dpo-2023.pdf')], true);
    const m = mount(ComposerMentionMenu, p);
    const dirRow = m.find('mention-dir-refs');
    const fileRow = m.find('mention-item-refs/dpo-2023.pdf');
    expect(textOf(dirRow)).toContain('refs/');
    expect(textOf(fileRow)).toContain('dpo-2023.pdf');
    const icons = (el: MiniElement) => {
      const hits: MiniElement[] = [];
      walk(el, (n) => { if (n.type === NavIcon) hits.push(n); });
      return hits;
    };
    expect(icons(dirRow).map((i) => i.props.name)).toEqual(['folder']);
    expect(icons(fileRow)).toHaveLength(0);
    dirRow.props.onMouseDown({ preventDefault: vi.fn() });
    expect(p.onSelect).toHaveBeenLastCalledWith(dir('refs'));
    fileRow.props.onMouseDown({ preventDefault: vi.fn() });
    expect(p.onSelect).toHaveBeenLastCalledWith(file('refs/dpo-2023.pdf'));
  });

  it('只画视口里的几行、上下占位撑开总高度；高亮挪到视口外时滚过去；同一份视图重渲染时行不重建、回调用的是最新的', () => {
    (globalThis as any).window = { innerHeight: 800 };
    const items = Array.from({ length: 1000 }, (_, i) => file(`f${String(i).padStart(4, '0')}.md`));
    const p = props(items, true);
    const m = mount(ComposerMentionMenu, p);
    const rowCount = () => findAllWhere(m.tree, (el) => String(el.props['data-testid'] ?? '').startsWith('mention-item-')).length;
    const heights = () => [m.find('mention-spacer-top').props.style.height, m.find('mention-spacer-bottom').props.style.height] as number[];
    // 正向：第一屏的行在；否定：第 500 行不在 DOM 里
    expect(m.query('mention-item-f0000.md')).not.toBeNull();
    expect(m.query('mention-item-f0500.md')).toBeNull();
    expect(rowCount()).toBe(16);
    expect(heights()).toEqual([0, (1000 - 16) * 28]);

    // 高亮挪到第 500 行：滚动区滚到让它整行露出来，那几行这才画出来
    m.rerender({ ...p, highlightIndex: 500 });
    const scroller = m.find('mention-scroll');
    expect((scroller.props.ref as { current: { scrollTop: number } }).current.scrollTop).toBe(501 * 28 - 320);
    expect(m.query('mention-item-f0500.md')).not.toBeNull();
    expect(m.query('mention-item-f0000.md')).toBeNull();
    const [top, bottom] = heights();
    expect(top + rowCount() * 28 + bottom).toBe(1000 * 28);

    // 用户自己滚（滚动事件）：按新的 scrollTop 画
    scroller.props.onScroll({ currentTarget: { scrollTop: 0 } });
    expect(m.query('mention-item-f0000.md')).not.toBeNull();

    // 父组件用同一份视图重渲染（回调是新的）：行还是原来那几个元素，按下去调的是新回调
    const before = m.find('mention-item-f0000.md');
    const onSelect2 = vi.fn();
    m.rerender({ ...p, highlightIndex: 500, onSelect: onSelect2 });
    expect(m.find('mention-item-f0000.md')).toBe(before);
    m.find('mention-item-f0000.md').props.onMouseDown({ preventDefault: vi.fn() });
    expect(onSelect2).toHaveBeenCalledWith(items[0]);
    expect(p.onSelect).not.toHaveBeenCalled();
  });

  it('没有结果：还在查找 →「正在查找…」；读完 →「没有匹配的文件」', () => {
    (globalThis as any).window = { innerHeight: 800 };
    const pending = mount(ComposerMentionMenu, props([], false));
    expect(textOf(pending.find('mention-menu'))).toBe('正在查找…');
    const finished = mount(ComposerMentionMenu, props([], true));
    expect(textOf(finished.find('mention-menu'))).toBe('没有匹配的文件');
    // 有结果时不出状态行（正向：上面两种状态行都真的渲染得出来）
    const withItems = mount(ComposerMentionMenu, props([file('a.md')], false));
    expect(textOf(withItems.find('mention-menu'))).not.toContain('正在查找…');
  });
});
