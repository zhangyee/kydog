import { create } from 'zustand';

type UnreadState = {
  unreadByThread: Record<string, true>;
  markUnread: (threadId: string) => void;
  markRead: (threadId: string) => void;
  clearOne: (threadId: string) => void;
};

export const useUnreadStore = create<UnreadState>((set) => ({
  unreadByThread: {},
  markUnread: (threadId) =>
    set((s) => (s.unreadByThread[threadId]
      ? {}
      : { unreadByThread: { ...s.unreadByThread, [threadId]: true } })),
  markRead: (threadId) =>
    set((s) => {
      if (!s.unreadByThread[threadId]) return {};
      const { [threadId]: _drop, ...rest } = s.unreadByThread;
      return { unreadByThread: rest };
    }),
  clearOne: (threadId) =>
    set((s) => {
      if (!s.unreadByThread[threadId]) return {};
      const { [threadId]: _drop, ...rest } = s.unreadByThread;
      return { unreadByThread: rest };
    }),
}));
