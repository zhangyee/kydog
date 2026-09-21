import { describe, it, expect, beforeEach } from 'vitest';
import { useThreadsStore, getCurrentThread } from './threadsStore';
import type { Thread, Message } from '../../shared/types';

/**
 * 渲染层的 thread 只有一个入口：bucketize()。已归档的在这里一处滤掉，hydrate（启动时拿的是
 * listAll()，含已归档）与 upsertThread（含 titleService 在归档之后才推回来的 thread.updated）
 * 都自动不让它进左栏（spec 2026-09-21-thread-archive-design §3.4）。
 */
const PROJECT = { path: '/p', addedAt: '2026-09-01T00:00:00.000Z' };
const ARCHIVED = '2026-09-21T00:00:00.000Z';
const T = (id: string, extra: Partial<Thread> = {}): Thread => ({
  id, projectPath: '/p', title: id, createdAt: '2026-09-01T00:00:00.000Z', lastActiveAt: '2026-09-01T00:00:00.000Z', ...extra,
});
const M = (id: string): Message => ({ id, role: 'user', createdAt: '2026-09-01T00:00:00.000Z', content: id });
const ids = () => Object.values(useThreadsStore.getState().threadsByProject).flat().map((t) => t.id).sort();

beforeEach(() => { useThreadsStore.setState(useThreadsStore.getInitialState()); });

describe('threadsStore：已归档的不进左栏', () => {
  it('hydrate 里混入已归档 → 不在任何桶里；同一个去掉 archivedAt 再 upsert → 回到桶里', () => {
    useThreadsStore.getState().hydrate([PROJECT], [T('a'), T('b', { archivedAt: ARCHIVED })]);
    expect(ids()).toEqual(['a']);
    useThreadsStore.getState().upsertThread(T('b'));
    expect(ids()).toEqual(['a', 'b']);
  });

  it('当前对话被 upsert 成已归档 → 出桶、currentThreadId 清空、它的 history 丢掉；b 的 history 不动', () => {
    const s = useThreadsStore.getState();
    s.hydrate([PROJECT], [T('a'), T('b')]);
    s.selectThread('a');
    s.setHistory('a', [M('m1')]);
    s.setHistory('b', [M('m2')]);
    expect(getCurrentThread(useThreadsStore.getState())?.id).toBe('a');
    expect(useThreadsStore.getState().historyByThread.a).toEqual([M('m1')]);

    useThreadsStore.getState().upsertThread(T('a', { archivedAt: ARCHIVED }));
    const after = useThreadsStore.getState();
    expect(ids()).toEqual(['b']);
    expect(after.currentThreadId).toBeNull();
    expect(after.historyByThread.a).toBeUndefined();
    expect(after.historyByThread.b).toEqual([M('m2')]);
  });

  it('归档的不是当前对话 → currentThreadId 不变，但它的 history 一样丢掉', () => {
    const s = useThreadsStore.getState();
    s.hydrate([PROJECT], [T('a'), T('b')]);
    s.selectThread('a');
    s.setHistory('b', [M('m2')]);
    expect(useThreadsStore.getState().historyByThread.b).toEqual([M('m2')]);

    useThreadsStore.getState().upsertThread(T('b', { archivedAt: ARCHIVED }));
    expect(ids()).toEqual(['a']);
    expect(useThreadsStore.getState().currentThreadId).toBe('a');
    expect(useThreadsStore.getState().historyByThread.b).toBeUndefined();
  });
});
