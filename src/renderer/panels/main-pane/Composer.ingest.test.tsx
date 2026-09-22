import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, findAllWhere, queryByTestId } from '../../../test-support/miniReact';

/**
 * Task 7 修复轮 1：三个附件入口里，`Composer.tsx` 自己接的两条（粘贴、回形针的
 * 文件选择器）之前没有接线用例——`composerHelpers.test.ts` / `composerIngest.test.ts`
 * 只测了纯函数本身，`ThreadView.drop.test.tsx` 只测了拖放那一条。这里补上另外两条，
 * 断言「组件事件回调组装出什么参数、转交给 ingestFiles」，不重复测 ingestFiles 自己
 * 的逻辑。`composerIngest` 整个 mock 掉。
 *
 * 第三条（回形针按钮本身：点击 → `fileInputRef.current?.click()`）在这一层测不了：
 * miniReact 挂到 `ref.current` 上的假元素（见 `src/test-support/miniReact.ts` 的
 * `FakeElement`）只有 `tagName` / `testId` / `getBoundingClientRect` / `focus` /
 * `blur` / `contentWindow?`，没有 `click`——真调用会当场 `TypeError: click is not a
 * function`。没有改 miniReact（不属于这一轮修复的范围），这一条留给 e2e。
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
vi.mock('./composerDraftStore', async (orig) => directRead(await orig<typeof import('./composerDraftStore')>(), 'useComposerDraftStore'));
vi.mock('./composerIngest', () => ({ ingestFiles: vi.fn() }));

const { Composer } = await import('./Composer');
const { ComposerEditor } = await import('./ComposerEditor');
const { ComposerActionsRow } = await import('./ComposerActionsRow');
const { useComposerDraftStore } = await import('./composerDraftStore');
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useLlmStore } = await import('../../stores/llmStore');
const { ingestFiles } = await import('./composerIngest');

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
function editorNode(tree: unknown) {
  return findAllWhere(tree as never, (el) => el.type === ComposerEditor)[0];
}
/** 回形针 + 隐藏 input 都在 `ComposerActionsRow` 的 `left` prop 里，不在 children——
 *  见 `narrowMode.test.tsx` 顶部注释同样的道理，`queryByTestId` 要单独对 `left` 找。 */
function actionsLeft(tree: unknown) {
  const [row] = findAllWhere(tree as never, (el) => el.type === ComposerActionsRow);
  return row.props.left;
}

beforeEach(() => {
  (globalThis as any).window = {
    kydog: { invoke: vi.fn().mockResolvedValue({ runId: 'r' }), on: () => () => {}, pathForFile: () => '', platform: 'darwin' },
    innerHeight: 800, innerWidth: 1200,
  };
  useThreadsStore.setState({ threadsByProject: { [PROJ]: [THREAD] } as never, historyByThread: { t1: [{ id: 'm0', role: 'user', content: 'x', createdAt: 'x' }] } });
  useComposerDraftStore.setState({ byThread: {} });
  useModel('anthropic', 'claude-sonnet-4-5', true);
  vi.mocked(ingestFiles).mockClear();
});

describe('Composer —— 附件入口接线', () => {
  it('粘贴：ComposerEditor 的 onPasteFiles 把文件原样转交给 ingestFiles', () => {
    const m = mount(Composer, { threadId: 't1' });
    const files = [{ name: 'a.png' } as File, { name: 'b.pdf' } as File];
    (editorNode(m.tree).props.onPasteFiles as (f: File[]) => void)(files);
    expect(ingestFiles).toHaveBeenCalledWith('t1', files);
  });

  it('回形针的文件选择器：隐藏 input 存在，onChange 把选中的文件转交 ingestFiles 并清空 value（免得选同一个文件第二次不触发 change）', () => {
    const m = mount(Composer, { threadId: 't1' });
    // 正向：先证明这个 input 真的在树上，免得下面 onChange 的断言其实是对着 undefined 空跑。
    const input = queryByTestId(actionsLeft(m.tree), 'composer-file-input');
    expect(input).not.toBeNull();
    const f1 = { name: 'a.pdf' } as File;
    const f2 = { name: 'b.png' } as File;
    const fakeEvent = { currentTarget: { files: [f1, f2], value: 'C:\\fakepath\\a.pdf' } };
    (input!.props.onChange as (e: typeof fakeEvent) => void)(fakeEvent);
    expect(ingestFiles).toHaveBeenCalledWith('t1', [f1, f2]);
    expect(fakeEvent.currentTarget.value).toBe('');
  });
});
