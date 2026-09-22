import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, findAllWhere } from '../../../test-support/miniReact';

/**
 * Task 6：发送编码（`encodeUserTurn`）、不读图拦截（`imageInputBlocked`）、发送被拒时的
 * 回滚与草稿还原（spec §7）。照 `narrowMode.test.tsx` 的模式：`vi.mock('react')` 换
 * miniReact 的 hooks；组件用到的每个 zustand store 都换成「直读 getState」的替身。
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

const { Composer } = await import('./Composer');
const { ComposerTray } = await import('./ComposerTray');
const { ComposerSendButton } = await import('./ComposerSendButton');
const { ComposerActionsRow } = await import('./ComposerActionsRow');
const { useComposerDraftStore, EMPTY_DRAFT } = await import('./composerDraftStore');
const { useThreadsStore } = await import('../../stores/threadsStore');
const { useLlmStore } = await import('../../stores/llmStore');
const { encodeUserTurn } = await import('../../../shared/userTurn');

const PROJ = '/proj';
const THREAD = { id: 't1', projectPath: PROJ, title: 'x', createdAt: 'x', lastActiveAt: 'x' };
const IMG = { id: 'i1', kind: 'image' as const, name: '截图 1', absPath: null, data: 'AAAA', mimeType: 'image/png' };

function entry(providerId: string, modelIds: string[], imageInputModelIds: string[]) {
  return { providerId, displayName: providerId, kind: 'apiKey' as const, authStatus: { configured: true }, modelIds, imageInputModelIds, defaultModel: modelIds[0] };
}
function useModel(providerId: string, modelId: string, imageOk: boolean) {
  useLlmStore.setState({
    configured: [entry(providerId, [modelId], imageOk ? [modelId] : [])] as never,
    defaultProvider: providerId as never, defaultModel: modelId,
  });
}
function sendButton(tree: unknown) {
  const [row] = findAllWhere(tree as never, (el) => el.type === ComposerActionsRow);
  const [btn] = findAllWhere(row.props.right as never, (el) => el.type === ComposerSendButton);
  return btn;
}
function tray(tree: unknown) {
  return findAllWhere(tree as never, (el) => el.type === ComposerTray)[0];
}

let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  invoke = vi.fn().mockResolvedValue({ runId: 'r' });
  (globalThis as any).window = { kydog: { invoke, on: () => () => {}, pathForFile: () => '', platform: 'darwin' }, innerHeight: 800, innerWidth: 1200 };
  useThreadsStore.setState({ threadsByProject: { [PROJ]: [THREAD] } as never, historyByThread: { t1: [{ id: 'm0', role: 'user', content: 'x', createdAt: 'x' }] } });
  useComposerDraftStore.setState({ byThread: {} });
});

describe('Composer —— 不读图拦截', () => {
  it('有图 + 当前模型不读图：发送禁用、托盘出提示；换成读图的模型：放开、提示消失', () => {
    useComposerDraftStore.setState({ byThread: { t1: { ...EMPTY_DRAFT, attachments: [IMG] } } });
    useModel('deepseek', 'deepseek-v4-flash', false);
    let m = mount(Composer, { threadId: 't1' });
    expect(sendButton(m.tree).props.disabled).toBe(true);
    expect(tray(m.tree).props.blockedHint).toBe('当前模型不支持图片输入');

    useModel('anthropic', 'claude-sonnet-4-5', true);
    m = mount(Composer, { threadId: 't1' });
    expect(sendButton(m.tree).props.disabled).toBe(false);
    expect(tray(m.tree).props.blockedHint).toBeNull();
  });

  it('只有附件没有正文也能发（发送键不禁用）；一样都没有时禁用', () => {
    useModel('anthropic', 'claude-sonnet-4-5', true);
    expect(sendButton(mount(Composer, { threadId: 't1' }).tree).props.disabled).toBe(true);
    useComposerDraftStore.setState({ byThread: { t1: { ...EMPTY_DRAFT, attachments: [IMG] } } });
    expect(sendButton(mount(Composer, { threadId: 't1' }).tree).props.disabled).toBe(false);
  });
});

describe('Composer —— 发送', () => {
  beforeEach(() => useModel('anthropic', 'claude-sonnet-4-5', true));

  it('发出去的是 encodeUserTurn 的结果：项目内相对路径、项目外绝对路径、图片单独带上；草稿清空、历史里是同一段文字', async () => {
    const draft = {
      ...EMPTY_DRAFT, body: '看这些',
      attachments: [
        { id: 'f1', kind: 'file' as const, name: 'a.pdf', absPath: `${PROJ}/refs/a.pdf` },
        { id: 'f2', kind: 'file' as const, name: 'b.pdf', absPath: '/Users/yee/Downloads/b.pdf' },
        IMG,
      ],
      comments: [{ id: 'c1', absPath: `${PROJ}/notes/ch3.md`, section: '3.2', quote: 'q', note: 'n', sourceTabId: 'x' }],
    };
    useComposerDraftStore.setState({ byThread: { t1: draft } });
    const m = mount(Composer, { threadId: 't1' });
    await (sendButton(m.tree).props.onClick as () => Promise<void>)();
    const expected = encodeUserTurn({
      body: '看这些',
      attachments: [{ kind: 'file', path: 'refs/a.pdf' }, { kind: 'file', path: '/Users/yee/Downloads/b.pdf' }, { kind: 'image', name: '截图 1', data: 'AAAA', mimeType: 'image/png' }],
      comments: [{ file: 'notes/ch3.md', section: '3.2', quote: 'q', note: 'n' }],
    });
    expect(invoke).toHaveBeenCalledWith('thread.send', { threadId: 't1', content: expected.text, images: expected.images });
    expect(useComposerDraftStore.getState().byThread['t1']).toBeUndefined();
    const last = useThreadsStore.getState().historyByThread['t1']!.at(-1)!;
    expect(last).toMatchObject({ role: 'user', content: expected.text, images: expected.images });
  });

  it('发送被拒：乐观加进去的那条被撤掉，正文 / 附件 / 批注原样放回，错误显示出来', async () => {
    let reject!: (e: Error) => void;
    invoke.mockImplementationOnce(() => new Promise((_, r) => { reject = r; }));
    useComposerDraftStore.setState({ byThread: { t1: { ...EMPTY_DRAFT, body: '看图', attachments: [IMG] } } });
    const m = mount(Composer, { threadId: 't1' });
    const sending = (sendButton(m.tree).props.onClick as () => Promise<void>)();
    // 正向：请求还没回来时，那条消息确实已经乐观写进历史、草稿已清空
    expect(useThreadsStore.getState().historyByThread['t1']!.map((x) => (x.role === 'user' ? x.content : ''))).toContain(
      encodeUserTurn({ body: '看图', attachments: [{ kind: 'image', name: '截图 1', data: 'AAAA', mimeType: 'image/png' }], comments: [] }).text,
    );
    expect(useComposerDraftStore.getState().byThread['t1']).toBeUndefined();
    reject(Object.assign(new Error('当前模型不支持图片输入'), { code: 'llm.imageUnsupported' }));
    await sending;
    expect(useThreadsStore.getState().historyByThread['t1']!.map((x) => x.id)).toEqual(['m0']);
    expect(useComposerDraftStore.getState().byThread['t1']).toMatchObject({ body: '看图', attachments: [IMG] });
    // 错误显示出来：同一个 mount 的树重渲染后能找到失败提示节点（正向对照见「发送被拒」之外
    // 的成功路径不会出现这个 testid —— 上一条用例没有它，说明它不是常驻节点）。
    const failureNode = findAllWhere(m.tree as never, (el) => el.props?.['data-testid'] === 'composer-send-failure');
    expect(failureNode).toHaveLength(1);
  });
});
