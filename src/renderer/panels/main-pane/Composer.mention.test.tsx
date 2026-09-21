import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, findAllWhere } from '../../../test-support/miniReact';

/**
 * Task 8：@ 触发行内引用 —— Composer 接 mention 查询到 `project.searchFiles`（首次带
 * rescan、之后不带）、索引版本号变化时重查、查询结束后关列表。照 `Composer.attachments.test.tsx`
 * 的模式：`vi.mock('react')` 换 miniReact 的 hooks；组件用到的每个 zustand store 都换成
 * 「直读 getState」的替身；子组件不展开，按 `el.type === 子组件` 在树里找 props。
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

vi.mock('../../stores/uiStore', async (orig) => directRead(await orig<typeof import('../../stores/uiStore')>(), 'useUiStore'));
vi.mock('../../stores/threadsStore', async (orig) => directRead(await orig<typeof import('../../stores/threadsStore')>(), 'useThreadsStore'));
vi.mock('../../stores/runsStore', async (orig) => directRead(await orig<typeof import('../../stores/runsStore')>(), 'useRunsStore'));
vi.mock('../../stores/llmStore', async (orig) => directRead(await orig<typeof import('../../stores/llmStore')>(), 'useLlmStore'));
vi.mock('../../stores/skillsStore', async (orig) => directRead(await orig<typeof import('../../stores/skillsStore')>(), 'useSkillsStore'));
vi.mock('../../stores/fileIndexStore', async (orig) => directRead(await orig<typeof import('../../stores/fileIndexStore')>(), 'useFileIndexStore'));
vi.mock('./composerDraftStore', async (orig) => directRead(await orig<typeof import('./composerDraftStore')>(), 'useComposerDraftStore'));

const { Composer } = await import('./Composer');
const { ComposerEditor } = await import('./ComposerEditor');
const { ComposerMentionMenu } = await import('./ComposerMentionMenu');
const { useComposerDraftStore } = await import('./composerDraftStore');
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useLlmStore } = await import('../../stores/llmStore');
const { useFileIndexStore } = await import('../../stores/fileIndexStore');

const PROJ = '/proj';
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

let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  invoke = vi.fn().mockResolvedValue({ runId: 'r' });
  (globalThis as any).window = { kydog: { invoke, on: () => () => {}, pathForFile: () => '', platform: 'darwin' }, innerHeight: 800, innerWidth: 1200 };
  useThreadsStore.setState({ threadsByProject: { [PROJ]: [THREAD] } as never, historyByThread: { t1: [{ id: 'm0', role: 'user', content: 'x', createdAt: 'x' }] } });
  useComposerDraftStore.setState({ byThread: {} });
  useModel('anthropic', 'claude-sonnet-4-5', true);
  useFileIndexStore.setState({ versionByProject: {} });
});

describe('Composer —— @ 列表', () => {
  it('打出 @dp：按对话的项目查、第一次带 rescan；接着打 @dpo：不再 rescan；列表拿到结果', async () => {
    invoke.mockResolvedValue({ items: [{ path: 'refs/dpo-2023.pdf' }], indexed: true });
    const m = mount(Composer, { threadId: 't1' });
    editor(m.tree).props.onMentionQuery('dp');
    await Promise.resolve(); await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('project.searchFiles', { projectPath: PROJ, query: 'dp', rescan: true });
    editor(m.tree).props.onMentionQuery('dpo');
    await Promise.resolve(); await Promise.resolve();
    expect(invoke).toHaveBeenLastCalledWith('project.searchFiles', { projectPath: PROJ, query: 'dpo', rescan: false });
    expect(menu(m.tree)[0].props.items).toEqual(['refs/dpo-2023.pdf']);
  });

  it('查询结束（null）后列表关掉；再打开是新的一次，又带 rescan', async () => {
    invoke.mockResolvedValue({ items: [], indexed: false });
    const m = mount(Composer, { threadId: 't1' });
    editor(m.tree).props.onMentionQuery('a');
    await Promise.resolve(); await Promise.resolve();
    // 正向：查询打开时列表确实在（下面才断言 null 之后它不在）
    expect(menu(m.tree)).toHaveLength(1);
    editor(m.tree).props.onMentionQuery(null);
    expect(menu(m.tree)).toHaveLength(0);
    editor(m.tree).props.onMentionQuery('b');
    await Promise.resolve(); await Promise.resolve();
    expect(invoke).toHaveBeenLastCalledWith('project.searchFiles', { projectPath: PROJ, query: 'b', rescan: true });
  });

  it('索引更新（版本号 +1）时开着的列表重查，不带 rescan', async () => {
    invoke.mockResolvedValue({ items: [], indexed: false });
    const m = mount(Composer, { threadId: 't1' });
    editor(m.tree).props.onMentionQuery('a');
    await Promise.resolve(); await Promise.resolve();
    const before = invoke.mock.calls.length;
    useFileIndexStore.getState().bump(PROJ);
    m.rerender({ threadId: 't1' });
    await Promise.resolve(); await Promise.resolve();
    expect(invoke.mock.calls.length).toBe(before + 1);
    expect(invoke).toHaveBeenLastCalledWith('project.searchFiles', { projectPath: PROJ, query: 'a', rescan: false });
  });

  it('新一次弹出自己的第一条结果回来之前：不接着显示上一次 session 的旧结果（也不能提前判成「没有匹配」）', async () => {
    invoke.mockResolvedValueOnce({ items: [{ path: 'refs/a.pdf' }], indexed: true });
    const m = mount(Composer, { threadId: 't1' });
    editor(m.tree).props.onMentionQuery('a');
    await Promise.resolve(); await Promise.resolve();
    // 正向：第一次 session 的结果确实渲染出来了 —— 后面「不渲染」的负向断言才立得住。
    expect(menu(m.tree)).toHaveLength(1);
    expect(menu(m.tree)[0].props.items).toEqual(['refs/a.pdf']);

    editor(m.tree).props.onMentionQuery(null);
    expect(menu(m.tree)).toHaveLength(0);

    // 新一次弹出：query 变了、这次的 invoke 先不回（挂起）。
    let resolveSecond!: (r: { items: { path: string }[]; indexed: boolean }) => void;
    invoke.mockImplementationOnce(() => new Promise((res) => { resolveSecond = res; }));
    editor(m.tree).props.onMentionQuery('b');
    await Promise.resolve(); await Promise.resolve();
    // 否定：自己的结果还没回来，列表不渲染 —— 不是继续显示上一次 session 的 'refs/a.pdf'。
    expect(menu(m.tree)).toHaveLength(0);

    // 结果回来了（未索引完，没有匹配）：列表这才渲染，且是这次自己的结果（indexed: false
    // 触发「正在索引项目文件…」，不是把「没结果」误判成「没有匹配的文件」）。
    resolveSecond({ items: [], indexed: false });
    await Promise.resolve(); await Promise.resolve();
    expect(menu(m.tree)).toHaveLength(1);
    expect(menu(m.tree)[0].props.items).toEqual([]);
    expect(menu(m.tree)[0].props.indexed).toBe(false);
  });
});
