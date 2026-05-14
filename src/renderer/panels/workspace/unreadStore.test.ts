import { describe, it, expect, beforeEach } from 'vitest';
import { useUnreadStore } from './unreadStore';

describe('useUnreadStore', () => {
  beforeEach(() => {
    useUnreadStore.setState({ unreadByThread: {} });
  });

  it('默认空', () => {
    expect(useUnreadStore.getState().unreadByThread).toEqual({});
  });

  it('markUnread 标记 thread', () => {
    useUnreadStore.getState().markUnread('t1');
    expect(useUnreadStore.getState().unreadByThread.t1).toBe(true);
  });

  it('markUnread 幂等', () => {
    const s = useUnreadStore.getState();
    s.markUnread('t1');
    const before = useUnreadStore.getState().unreadByThread;
    s.markUnread('t1');
    const after = useUnreadStore.getState().unreadByThread;
    expect(after).toBe(before);
  });

  it('markRead 清除 unread', () => {
    const s = useUnreadStore.getState();
    s.markUnread('t1');
    s.markUnread('t2');
    s.markRead('t1');
    expect(useUnreadStore.getState().unreadByThread).toEqual({ t2: true });
  });

  it('markRead 对从未 unread 的 thread 是 noop', () => {
    const before = useUnreadStore.getState().unreadByThread;
    useUnreadStore.getState().markRead('t1');
    expect(useUnreadStore.getState().unreadByThread).toBe(before);
  });

  it('clearOne 行为同 markRead', () => {
    const s = useUnreadStore.getState();
    s.markUnread('t1');
    s.clearOne('t1');
    expect(useUnreadStore.getState().unreadByThread).toEqual({});
  });
});
