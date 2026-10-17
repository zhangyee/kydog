import { beforeEach, describe, expect, it } from 'vitest';
import type { XResearchTaskSnapshot } from '../../shared/xResearchTask';
import { useXResearchTaskStore } from './xResearchTaskStore';

function snapshot(over: Partial<XResearchTaskSnapshot> = {}): XResearchTaskSnapshot {
  return {
    researchRunId: 'xrun-a', threadId: 'thread-a', revision: 1, state: 'running',
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:01.000Z',
    objective: '找到讨论此事的帖子', counts: {
      submissions: 1, queued: 0, running: 1, done: 0, failed: 0, cancelled: 0,
      interrupted: 0, posts: 0, replies: 0, articles: 0, undelivered: 0,
    },
    budget: { scrolls: 50, expandActions: 10 }, usage: { posts: 0, scrolls: 0, expandActions: 0 },
    search: [], read: [],
    ...over,
  };
}

describe('xResearchTaskStore', () => {
  beforeEach(() => useXResearchTaskStore.setState({ snapshotsByRunId: {} }));

  it('ignores an out-of-order snapshot with a lower revision', () => {
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 3, state: 'running' }));
    useXResearchTaskStore.getState().upsert(snapshot({ revision: 2, state: 'completed' }));
    expect(useXResearchTaskStore.getState().snapshotsByRunId['xrun-a']).toMatchObject({
      revision: 3, state: 'running',
    });
  });

  it('replaces a thread wholesale so a resync cannot keep stale rows', () => {
    const store = useXResearchTaskStore.getState();
    store.upsert(snapshot({ researchRunId: 'xrun-a' }));
    store.upsert(snapshot({ researchRunId: 'xrun-b' }));
    store.upsert(snapshot({ researchRunId: 'xrun-c', threadId: 'thread-b' }));

    store.replaceThread('thread-a', [snapshot({ researchRunId: 'xrun-a', revision: 5, state: 'completed' })]);

    expect(useXResearchTaskStore.getState().snapshotsByRunId['xrun-a']).toMatchObject({
      revision: 5, state: 'completed',
    });
    expect(useXResearchTaskStore.getState().snapshotsByRunId['xrun-b']).toBeUndefined();
    expect(useXResearchTaskStore.getState().snapshotsByRunId['xrun-c']).toMatchObject({
      threadId: 'thread-b', revision: 1,
    });
  });

  it('reset drops only that thread', () => {
    const store = useXResearchTaskStore.getState();
    store.upsert(snapshot({ researchRunId: 'xrun-a' }));
    store.upsert(snapshot({ researchRunId: 'xrun-b' }));
    store.upsert(snapshot({ researchRunId: 'xrun-c', threadId: 'thread-b' }));

    store.reset('thread-a');

    expect(Object.keys(useXResearchTaskStore.getState().snapshotsByRunId)).toEqual(['xrun-c']);
  });

  it('keeps snapshots of two threads independent through upsert', () => {
    const store = useXResearchTaskStore.getState();
    store.upsert(snapshot({ researchRunId: 'xrun-a', threadId: 'thread-a' }));
    store.upsert(snapshot({ researchRunId: 'xrun-b', threadId: 'thread-b' }));
    store.upsert(snapshot({ researchRunId: 'xrun-a', threadId: 'thread-a', revision: 2, state: 'completed' }));

    expect(useXResearchTaskStore.getState().snapshotsByRunId['xrun-a']).toMatchObject({
      threadId: 'thread-a', revision: 2, state: 'completed',
    });
    expect(useXResearchTaskStore.getState().snapshotsByRunId['xrun-b']).toMatchObject({
      threadId: 'thread-b', revision: 1, state: 'running',
    });
  });
});
