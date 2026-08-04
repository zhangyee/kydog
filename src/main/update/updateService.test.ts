import { describe, it, expect, vi } from 'vitest';
import { UpdateService } from './updateService';
import type { CheckEngine, CheckOutcome } from './engine';

function scriptedEngine(outcomes: CheckOutcome[]) {
  let i = 0;
  let lateCb: ((o: CheckOutcome) => void) | null = null;
  const e: CheckEngine & { late(o: CheckOutcome): void; runs: number } = {
    runs: 0,
    async run() { e.runs += 1; return outcomes[Math.min(i++, outcomes.length - 1)]; },
    onLateOutcome(cb) { lateCb = cb; },
    quitAndInstall: vi.fn(),
    late(o) { lateCb?.(o); },
  };
  return e;
}

function svc(engine: CheckEngine, opts?: { autoCheck?: boolean }) {
  return new UpdateService({
    engine,
    currentVersion: '0.1.0',
    deadlineMs: 1000,
    initialAutoCheck: opts?.autoCheck ?? true,
    initialDismissedCandidateId: null,
    persistAutoCheck: async () => {},
    persistDismissed: async () => {},
    onStatusChange: () => {},
  });
}

describe('UpdateService 状态迁移', () => {
  it('初始为 never + none', () => {
    const s = svc(scriptedEngine([{ kind: 'none' }]));
    expect(s.getStatus().check).toEqual({ phase: 'never' });
    expect(s.getStatus().update).toEqual({ kind: 'none' });
    expect(s.getStatus().currentVersion).toBe('0.1.0');
  });

  it('none → check.ok + update.none', async () => {
    const s = svc(scriptedEngine([{ kind: 'none' }]));
    await s.check();
    expect(s.getStatus().check).toEqual({ phase: 'ok' });
    expect(s.getStatus().update).toEqual({ kind: 'none' });
  });

  it('available → 带 candidateId 与 label', async () => {
    const s = svc(scriptedEngine([{ kind: 'available', candidateId: 'c1', label: 'KyDog 0.2.0' }]));
    await s.check();
    expect(s.getStatus().update).toEqual({ kind: 'available', candidateId: 'c1', label: 'KyDog 0.2.0' });
  });

  it('不变量：检查失败只写 check，绝不触碰 update', async () => {
    const e = scriptedEngine([
      { kind: 'available', candidateId: 'c1', label: 'v2' },
      { kind: 'failed', message: 'boom', retry: 'allowed' },
    ]);
    const s = svc(e);
    await s.check();
    await s.check();
    expect(s.getStatus().check).toMatchObject({ phase: 'failed', message: 'boom', retry: 'allowed' });
    expect(s.getStatus().update).toEqual({ kind: 'available', candidateId: 'c1', label: 'v2' });
  });

  it('不变量：downloaded 不可降级，后续 none 不能把它打回', async () => {
    const e = scriptedEngine([{ kind: 'downloaded', label: 'v2' }, { kind: 'none' }]);
    const s = svc(e);
    await s.check();
    await s.check();
    expect(s.getStatus().update).toEqual({ kind: 'downloaded', label: 'v2' });
  });

  it('downloaded 是进程终态：此后不再调用底层引擎', async () => {
    const e = scriptedEngine([{ kind: 'downloaded', label: 'v2' }, { kind: 'none' }]);
    const s = svc(e);
    await s.check();
    expect(e.runs).toBe(1);
    await s.check();
    expect(e.runs).toBe(1);
    expect(s.getStatus().update).toEqual({ kind: 'downloaded', label: 'v2' });
  });
});

describe('UpdateService 迟到事件（Windows deadline 之后）', () => {
  async function timedOut() {
    const e = scriptedEngine([{ kind: 'failed', message: '超时', retry: 'restart-required' }]);
    const s = svc(e);
    await s.check();
    expect(s.getStatus().check).toMatchObject({ retry: 'restart-required' });
    return { e, s };
  }

  it('迟到 update-not-available：解除禁用，回到 ok + none，且此后确实能再检查', async () => {
    const { e, s } = await timedOut();
    const before = e.runs;
    e.late({ kind: 'none' });
    expect(s.getStatus().check).toEqual({ phase: 'ok' });
    expect(s.getStatus().update).toEqual({ kind: 'none' });
    await s.check();
    expect(e.runs).toBe(before + 1); // 内部可检查性也恢复了，不只是状态字段好看
  });

  it('迟到 error：解除禁用，retry 变回 allowed', async () => {
    const { e, s } = await timedOut();
    e.late({ kind: 'failed', message: 'boom', retry: 'allowed' });
    expect(s.getStatus().check).toMatchObject({ phase: 'failed', retry: 'allowed' });
    await s.check();
    expect(e.runs).toBe(2);
  });

  it('迟到 downloaded：点亮不可降级终态，且此后不再检查', async () => {
    const { e, s } = await timedOut();
    e.late({ kind: 'downloaded', label: 'v2' });
    expect(s.getStatus().update).toEqual({ kind: 'downloaded', label: 'v2' });
    const before = e.runs;
    await s.check();
    expect(e.runs).toBe(before);
  });

  it('deadline 后仍处于禁用时，手动检查不调用引擎', async () => {
    const { e, s } = await timedOut();
    const before = e.runs;
    await s.check();
    expect(e.runs).toBe(before);
  });
});
