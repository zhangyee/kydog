import { describe, it, expect, beforeEach } from 'vitest';
import { useThreadsStore } from './threadsStore';
import type { Message } from '../../shared/types';

describe('threadsStore', () => {
  beforeEach(() => { useThreadsStore.setState({ historyByThread: {} }); });

  it('removeMessage 只删那一条，其他消息与其他对话不动', () => {
    const S = useThreadsStore.getState;
    S().appendUserMessage('t1', { id: 'a', role: 'user', content: 'A', createdAt: 'x' } as Message);
    S().appendUserMessage('t1', { id: 'b', role: 'user', content: 'B', createdAt: 'x' } as Message);
    S().appendUserMessage('t2', { id: 'a', role: 'user', content: 'A2', createdAt: 'x' } as Message);
    S().removeMessage('t1', 'a');
    expect(S().historyByThread['t1']!.map((m) => m.id)).toEqual(['b']);
    expect(S().historyByThread['t2']!.map((m) => m.id)).toEqual(['a']);
  });
});


describe('thread navigation identity', () => {
  beforeEach(() => useThreadsStore.setState(useThreadsStore.getInitialState(), true));
  const t = (id: string, projectPath = '/a') => ({ id, projectPath, title: id, createdAt: '1', lastActiveAt: '2' });
  it('every explicit selection, including same ID and null, advances revision', () => {
    const s = useThreadsStore.getState();
    expect(s.threadNavigationRevision).toBe(0);
    s.hydrate([], [t('a')]);
    s.selectThread('a');
    expect(useThreadsStore.getState().threadNavigationRevision).toBe(1);
    s.selectThread('a');
    expect(useThreadsStore.getState().threadNavigationRevision).toBe(2);
    s.selectThread(null);
    expect(useThreadsStore.getState().threadNavigationRevision).toBe(3);
  });
  it('only an existing current thread project migration advances revision on upsert', () => {
    const s = useThreadsStore.getState();
    s.hydrate([], [t('a'), t('b')]); s.selectThread('a');
    const revision = useThreadsStore.getState().threadNavigationRevision;
    s.upsertThread({ ...t('a'), title: 'renamed', lastActiveAt: '9' });
    s.upsertThread(t('b', '/b'));
    s.upsertThread(t('new', '/b'));
    expect(useThreadsStore.getState().threadNavigationRevision).toBe(revision);
    s.upsertThread(t('a', '/b'));
    expect(useThreadsStore.getState().threadNavigationRevision).toBe(revision + 1);
    s.upsertThread(t('a', '/b'));
    expect(useThreadsStore.getState().threadNavigationRevision).toBe(revision + 1);
  });
});
