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
