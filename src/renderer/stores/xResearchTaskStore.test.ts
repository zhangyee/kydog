import { beforeEach, describe, expect, it } from 'vitest';
import type { XResearchTaskSnapshot } from '../../shared/xResearchTask';
import { useXResearchTaskStore, xResearchTaskGroupKey, xResearchTaskSegments } from './xResearchTaskStore';

function snapshot(over: Partial<XResearchTaskSnapshot> = {}): XResearchTaskSnapshot {
  return {
    researchRunId: 'xrun-a', threadId: 'thread-a', revision: 1, state: 'running',
    createdAt: '2026-10-16T00:00:00.000Z', updatedAt: '2026-10-16T00:00:01.000Z',
    objective: '找到讨论此事的帖子', counts: {
      submissions: 1, queued: 0, running: 1, done: 0, failed: 0, cancelled: 0,
      interrupted: 0, posts: 0, replies: 0, articles: 0, undelivered: 0,
      searchDone: 0, searchTotal: 0, readDone: 0, readTotal: 0,
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

  it('keeps the stored snapshot when a resync list carries an older revision of it', () => {
    const store = useXResearchTaskStore.getState();
    store.upsert(snapshot({ researchRunId: 'xrun-a', revision: 5, state: 'completed' }));
    store.upsert(snapshot({ researchRunId: 'xrun-c', revision: 2, state: 'cancelled' }));
    store.upsert(snapshot({ researchRunId: 'xrun-d', threadId: 'thread-b' }));

    // resync 的列表是更早时刻从盘上算出来的：那期间广播已经把 xrun-a 推到 rev 5 的终态。
    useXResearchTaskStore.getState().replaceThread('thread-a', [
      snapshot({ researchRunId: 'xrun-a', revision: 3, state: 'running' }),
      snapshot({ researchRunId: 'xrun-b', revision: 1, state: 'running' }),
    ]);

    const after = useXResearchTaskStore.getState().snapshotsByRunId;
    // 倒退的那条留在位：否则卡片会从「完成」退回「运行中」，而 upsert 的守卫管不到这一支。
    expect(after['xrun-a']).toMatchObject({ revision: 5, state: 'completed' });
    // 列表里新出现的那条照常落入 —— 守卫只挡「倒退」，不是把整批替换降级成合并。
    expect(after['xrun-b']).toMatchObject({ revision: 1, state: 'running' });
    // 整批语义照旧：不在列表里的同线程行仍被清掉。
    expect(after['xrun-c']).toBeUndefined();
    // 别的线程不受影响。
    expect(after['xrun-d']).toMatchObject({ threadId: 'thread-b', revision: 1 });
  });

  it('lets an equal-revision resync snapshot overwrite, mirroring upsert', () => {
    const store = useXResearchTaskStore.getState();
    store.upsert(snapshot({ researchRunId: 'xrun-a', revision: 4, state: 'running' }));

    store.replaceThread('thread-a', [
      snapshot({ researchRunId: 'xrun-a', revision: 4, state: 'completed' }),
    ]);

    expect(useXResearchTaskStore.getState().snapshotsByRunId['xrun-a']).toMatchObject({
      revision: 4, state: 'completed',
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

  it('derives one group per turn in createdAt order — three researches of one run are one card', () => {
    const store = useXResearchTaskStore.getState();
    // 同一个回合里三段研究（取消后重开两次）：`runId` 相同，`createdAt` 决定段序。
    store.upsert(snapshot({ researchRunId: 'xrun-b', runId: 'turn-1',
      createdAt: '2026-10-16T00:00:02.000Z' }));
    store.upsert(snapshot({ researchRunId: 'xrun-a', runId: 'turn-1',
      createdAt: '2026-10-16T00:00:01.000Z' }));
    store.upsert(snapshot({ researchRunId: 'xrun-c', runId: 'turn-1',
      createdAt: '2026-10-16T00:00:03.000Z' }));

    const pool = useXResearchTaskStore.getState().snapshotsByRunId;
    expect(Object.keys(pool)).toHaveLength(3);
    expect(xResearchTaskSegments(pool, 'turn-1').map((segment) => segment.researchRunId))
      .toEqual(['xrun-a', 'xrun-b', 'xrun-c']);
    // 池子仍是按研究存的（广播照旧一段一段地到）：分组是读的时候算出来的那一层。
    expect(pool['xrun-b']).toMatchObject({ runId: 'turn-1' });
  });

  it('an update replaces only its own research inside the group and keeps the order', () => {
    const store = useXResearchTaskStore.getState();
    store.upsert(snapshot({ researchRunId: 'xrun-a', runId: 'turn-1',
      createdAt: '2026-10-16T00:00:01.000Z', revision: 1, state: 'running' }));
    store.upsert(snapshot({ researchRunId: 'xrun-b', runId: 'turn-1',
      createdAt: '2026-10-16T00:00:02.000Z', revision: 1, state: 'running' }));

    store.upsert(snapshot({ researchRunId: 'xrun-a', runId: 'turn-1',
      createdAt: '2026-10-16T00:00:01.000Z', revision: 2, state: 'cancelled' }));

    const segments = xResearchTaskSegments(useXResearchTaskStore.getState().snapshotsByRunId, 'turn-1');
    expect(segments.map((segment) => [segment.researchRunId, segment.revision, segment.state]))
      .toEqual([['xrun-a', 2, 'cancelled'], ['xrun-b', 1, 'running']]);
  });

  it('keeps another turn separate and gives a record without runId its own group', () => {
    const store = useXResearchTaskStore.getState();
    store.upsert(snapshot({ researchRunId: 'xrun-a', runId: 'turn-1' }));
    store.upsert(snapshot({ researchRunId: 'xrun-b', runId: 'turn-2' }));
    // 旧数据：`task.json` 里没有 `runId`。分组键退回它自己的 id —— 一段研究一张卡，不空白。
    store.upsert(snapshot({ researchRunId: 'xrun-legacy' }));

    const pool = useXResearchTaskStore.getState().snapshotsByRunId;
    expect(xResearchTaskSegments(pool, 'turn-1').map((segment) => segment.researchRunId))
      .toEqual(['xrun-a']);
    expect(xResearchTaskSegments(pool, 'turn-2').map((segment) => segment.researchRunId))
      .toEqual(['xrun-b']);
    expect(xResearchTaskGroupKey(pool['xrun-legacy'])).toBe('xrun-legacy');
    expect(xResearchTaskSegments(pool, 'xrun-legacy').map((segment) => segment.researchRunId))
      .toEqual(['xrun-legacy']);
    // 旧的那条既不属于任何回合，也不把别的回合的研究吸进它那一组。
    expect(xResearchTaskSegments(pool, 'turn-1')).toHaveLength(1);
  });

  it('clears every group of a thread on reset and on a wholesale resync', () => {
    const store = useXResearchTaskStore.getState();
    store.upsert(snapshot({ researchRunId: 'xrun-a', runId: 'turn-1' }));
    store.upsert(snapshot({ researchRunId: 'xrun-b', runId: 'turn-1' }));

    store.reset('thread-a');
    expect(xResearchTaskSegments(useXResearchTaskStore.getState().snapshotsByRunId, 'turn-1')).toEqual([]);

    // 整批替换同理：这一回合只剩列表里那一份，组跟着缩到一段。
    store.upsert(snapshot({ researchRunId: 'xrun-a', runId: 'turn-1' }));
    store.upsert(snapshot({ researchRunId: 'xrun-b', runId: 'turn-1' }));
    store.replaceThread('thread-a', [snapshot({ researchRunId: 'xrun-a', runId: 'turn-1' })]);
    expect(xResearchTaskSegments(useXResearchTaskStore.getState().snapshotsByRunId, 'turn-1')
      .map((segment) => segment.researchRunId)).toEqual(['xrun-a']);
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
