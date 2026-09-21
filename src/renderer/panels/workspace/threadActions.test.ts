import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../stores/confirmStore', () => ({ confirm: vi.fn() }));
import { confirm } from '../../stores/confirmStore';
import { archiveThreads, deleteThreads } from './threadActions';
import { useThreadsStore } from '../../stores/threadsStore';
import { useToastStore } from '../../stores/toastStore';
import { useUnreadStore } from './unreadStore';
import { useComposerDraftStore } from '../main-pane/composerDraftStore';
import type { Thread } from '../../../shared/types';

/**
 * 归档 / 撤销 / 删除：调 RPC → 改 store → 出提示（spec 2026-09-21-thread-archive-design §2.4、§2.5）。
 * RPC 用一个记账的假 invoke；store 用真身（只走 getState / setState，不经 React）。
 */
const PROJECT = { path: '/p', addedAt: '2026-09-01T00:00:00.000Z' };
const T = (id: string, extra: Partial<Thread> = {}): Thread => ({
  id, projectPath: '/p', title: `标题-${id}`, createdAt: '2026-09-01T00:00:00.000Z', lastActiveAt: '2026-09-01T00:00:00.000Z', ...extra,
});
const ids = () => Object.values(useThreadsStore.getState().threadsByProject).flat().map((t) => t.id).sort();

type Call = { method: string; args: { threadIds: string[] } };
let calls: Call[] = [];
let reply: (c: Call) => Promise<unknown>;

beforeEach(() => {
  calls = [];
  useThreadsStore.setState(useThreadsStore.getInitialState());
  useThreadsStore.getState().hydrate([PROJECT], [T('a'), T('b'), T('c')]);
  useToastStore.setState({ toast: null });
  useUnreadStore.setState({ unreadByThread: {} });
  useComposerDraftStore.setState({ byThread: {} });
  vi.mocked(confirm).mockReset();
  reply = ({ method, args }) => {
    if (method === 'thread.archive') return Promise.resolve({ threads: args.threadIds.map((id) => T(id, { archivedAt: '2026-09-21T00:00:00.000Z' })) });
    if (method === 'thread.unarchive') return Promise.resolve({ threads: args.threadIds.map((id) => T(id)) });
    if (method === 'thread.delete') return Promise.resolve(undefined);
    return Promise.reject(new Error(`没接这条 RPC：${method}`));
  };
  (globalThis as unknown as Record<string, unknown>).window = {
    kydog: { invoke: (method: string, args: Call['args']) => { calls.push({ method, args }); return reply({ method, args }); } },
  };
});
afterEach(() => { delete (globalThis as unknown as Record<string, unknown>).window; });

describe('archiveThreads', () => {
  it('两个一起：一次 RPC、出桶、清未读、提示「已归档 2 个对话」；点撤销 → 同一批回来', async () => {
    useUnreadStore.getState().markUnread('a');
    await archiveThreads([T('a'), T('b')]);
    expect(calls).toEqual([{ method: 'thread.archive', args: { threadIds: ['a', 'b'] } }]);
    expect(ids()).toEqual(['c']);
    expect(useUnreadStore.getState().unreadByThread.a).toBeUndefined();

    const toast = useToastStore.getState().toast!;
    expect(toast.message).toBe('已归档 2 个对话');
    expect(toast.action!.label).toBe('撤销');
    toast.action!.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls[1]).toEqual({ method: 'thread.unarchive', args: { threadIds: ['a', 'b'] } });
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('一个：提示带标题「已归档「标题-a」」', async () => {
    await archiveThreads([T('a')]);
    expect(useToastStore.getState().toast!.message).toBe('已归档「标题-a」');
  });

  it('主进程回 thread.busy → 提示「有对话正在运行，没有归档」、无按钮，store 一条不动', async () => {
    reply = () => Promise.reject(Object.assign(new Error('busy'), { code: 'thread.busy' }));
    await archiveThreads([T('a'), T('b')]);
    const toast = useToastStore.getState().toast!;
    expect(toast.message).toBe('有对话正在运行，没有归档');
    expect(toast.action).toBeUndefined();
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('撤销失败 → 提示换成「撤销失败」', async () => {
    await archiveThreads([T('a')]);
    reply = () => Promise.reject(new Error('disk'));
    useToastStore.getState().toast!.action!.run();
    await new Promise((r) => setTimeout(r, 0));
    expect(useToastStore.getState().toast!.message).toBe('撤销失败');
  });
});

describe('deleteThreads', () => {
  it('确认框点取消 → 不发 RPC、返回 false；点确认 → 一次 RPC、出桶、清草稿与未读、返回 true', async () => {
    useComposerDraftStore.getState().setDraft('a', { skill: null, body: '写到一半' });
    useUnreadStore.getState().markUnread('b');

    vi.mocked(confirm).mockResolvedValueOnce(false);
    expect(await deleteThreads([T('a'), T('b')])).toBe(false);
    expect(calls).toEqual([]);
    expect(ids()).toEqual(['a', 'b', 'c']);

    vi.mocked(confirm).mockResolvedValueOnce(true);
    expect(await deleteThreads([T('a'), T('b')])).toBe(true);
    expect(vi.mocked(confirm).mock.calls[1][0]).toEqual({
      title: '删除 2 个对话？', message: '对话记录会从磁盘上删除，无法恢复。', confirmLabel: '删除',
    });
    expect(calls).toEqual([{ method: 'thread.delete', args: { threadIds: ['a', 'b'] } }]);
    expect(ids()).toEqual(['c']);
    expect(useComposerDraftStore.getState().byThread.a).toBeUndefined();
    expect(useUnreadStore.getState().unreadByThread.b).toBeUndefined();
  });

  it('一个：确认框标题带书名号「删除对话「标题-a」？」', async () => {
    vi.mocked(confirm).mockResolvedValueOnce(true);
    await deleteThreads([T('a')]);
    expect(vi.mocked(confirm).mock.calls[0][0]).toMatchObject({ title: '删除对话「标题-a」？' });
  });
});
