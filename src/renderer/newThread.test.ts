import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startNewThread, startNewThreadInFocusedProject } from './newThread';
import { useThreadsStore } from './stores/threadsStore';
import { useUiStore } from './stores/uiStore';
import type { Project, Thread } from '../shared/types';

const A = '/a';
const B = '/b';
const P = (path: string): Project => ({ path, addedAt: '2026-09-01T00:00:00.000Z' });
const T = (id: string, projectPath: string): Thread => ({
  id, projectPath, title: '无标题', createdAt: '2026-09-01T00:00:00.000Z', lastActiveAt: '2026-09-01T00:00:00.000Z',
});

describe('新建对话', () => {
  let invoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    let n = 0;
    invoke = vi.fn(async (_method: string, args: { projectPath: string }) => T(`new-${++n}`, args.projectPath));
    (globalThis as unknown as { window: unknown }).window = { kydog: { invoke } };
    useThreadsStore.setState(useThreadsStore.getInitialState());
    useUiStore.setState({ activeCenterTab: 'file' });
    useThreadsStore.getState().hydrate([P(A), P(B)], []);
  });
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  it('建在当前项目里（不是第一个项目），建完切过去', async () => {
    useThreadsStore.getState().addProject(P(B));
    const thread = await startNewThreadInFocusedProject();
    expect(invoke.mock.calls).toEqual([['thread.create', { projectPath: B }]]);
    expect(thread?.projectPath).toBe(B);
    const s = useThreadsStore.getState();
    expect(s.currentThreadId).toBe(thread?.id);
    expect(s.threadsByProject[B]?.map((t) => t.id)).toEqual([thread?.id]);
    expect(useUiStore.getState().activeCenterTab).toBe('thread');
  });

  it('给定项目的入口（项目行上的 +）：建在那个项目里，它随之成为当前项目', async () => {
    useThreadsStore.getState().addProject(P(A));
    await startNewThread(B);
    expect(invoke.mock.calls).toEqual([['thread.create', { projectPath: B }]]);
    expect(useThreadsStore.getState().focusedProjectPath).toBe(B);
  });

  it('一个项目都没有：不发请求，返回 null', async () => {
    await startNewThreadInFocusedProject();
    expect(invoke).toHaveBeenCalledTimes(1);
    useThreadsStore.getState().removeProject(A);
    useThreadsStore.getState().removeProject(B);
    expect(await startNewThreadInFocusedProject()).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
