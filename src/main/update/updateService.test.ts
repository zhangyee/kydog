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

  it('downloading：check 进入下载态，update 不变，且不是失败', async () => {
    const s = svc(scriptedEngine([{ kind: 'downloading' }]));
    await s.check();
    expect(s.getStatus().check).toEqual({ phase: 'downloading' });
    expect(s.getStatus().update).toEqual({ kind: 'none' });
  });

  it('下载中不再发起第二次检查：Electron 重复 checkForUpdates 会把包下两遍', async () => {
    const e = scriptedEngine([{ kind: 'downloading' }, { kind: 'none' }]);
    const s = svc(e);
    await s.check();
    await s.check();
    expect(e.runs).toBe(1);
  });

  it('deadline 判失败后，迟到的 downloading 解除禁用并如实说在下载', async () => {
    const e = scriptedEngine([
      { kind: 'failed', message: '检查更新超时；本次运行期间已停止检查，请重启应用', retry: 'restart-required' },
    ]);
    const s = svc(e);
    await s.check();
    expect(s.getStatus().check).toMatchObject({ phase: 'failed', retry: 'restart-required' });
    e.late({ kind: 'downloading' });
    expect(s.getStatus().check).toEqual({ phase: 'downloading' });
  });

  it('迟到的 downloaded 解除下载态：check 回 ok，update 拿到 downloaded', async () => {
    const e = scriptedEngine([{ kind: 'downloading' }]);
    const s = svc(e);
    await s.check();
    e.late({ kind: 'downloaded', label: 'KyDog 0.2.0' });
    expect(s.getStatus().check).toEqual({ phase: 'ok' });
    expect(s.getStatus().update).toEqual({ kind: 'downloaded', label: 'KyDog 0.2.0' });
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

describe('UpdateService single-flight', () => {
  it('并发 check() 只触发一次底层检查', async () => {
    let release!: (o: CheckOutcome) => void;
    let runs = 0;
    const engine: CheckEngine = {
      run: () => { runs += 1; return new Promise((r) => { release = r; }); },
      onLateOutcome: () => {},
      quitAndInstall: () => {},
    };
    const s = svc(engine);
    const a = s.check(); const b = s.check(); const c = s.check();
    expect(runs).toBe(1);
    release({ kind: 'none' });
    await Promise.all([a, b, c]);
    expect(runs).toBe(1);
  });

  it('前一次完成后可以再次检查', async () => {
    const e = scriptedEngine([{ kind: 'none' }, { kind: 'none' }]);
    const s = svc(e);
    await s.check();
    await s.check();
    expect(e.runs).toBe(2);
  });
});

describe('UpdateService 忽略与开关', () => {
  function svcWith(engine: CheckEngine, over: Partial<{
    persistDismissed: (id: string) => Promise<void>;
    persistAutoCheck: (v: boolean) => Promise<void>;
    onAutoCheckChanged: (v: boolean) => void;
    initialAutoCheck: boolean;
  }>) {
    return new UpdateService({
      engine, currentVersion: '0.1.0', deadlineMs: 1000,
      initialAutoCheck: over.initialAutoCheck ?? true,
      initialDismissedCandidateId: null,
      persistAutoCheck: over.persistAutoCheck ?? (async () => {}),
      persistDismissed: over.persistDismissed ?? (async () => {}),
      onStatusChange: () => {},
      onAutoCheckChanged: over.onAutoCheckChanged,
    });
  }

  it('available：忽略后 bannerDismissed 为真，且落盘的是 candidateId', async () => {
    const persisted: string[] = [];
    const e = scriptedEngine([{ kind: 'available', candidateId: 'c1', label: 'KyDog' }]);
    const s = svcWith(e, { persistDismissed: async (id) => { persisted.push(id); } });
    await s.check();
    expect(s.getStatus().bannerDismissed).toBe(false);
    await s.dismissBanner();
    expect(s.getStatus().bannerDismissed).toBe(true);
    expect(persisted).toEqual(['c1']);
  });

  it('label 相同但 candidateId 不同的下一个版本仍然出横幅', async () => {
    const e = scriptedEngine([
      { kind: 'available', candidateId: 'c1', label: 'KyDog' },
      { kind: 'available', candidateId: 'c2', label: 'KyDog' },
    ]);
    const s = svcWith(e, {});
    await s.check();
    await s.dismissBanner();
    expect(s.getStatus().bannerDismissed).toBe(true);
    await s.check();
    expect(s.getStatus().bannerDismissed).toBe(false);
  });

  it('downloaded 的忽略不落盘', async () => {
    const persisted: string[] = [];
    const e = scriptedEngine([{ kind: 'downloaded', label: 'v2' }]);
    const s = svcWith(e, { persistDismissed: async (id) => { persisted.push(id); } });
    await s.check();
    await s.dismissBanner();
    expect(s.getStatus().bannerDismissed).toBe(true);
    expect(persisted).toEqual([]);
  });

  it('setAutoCheck：值没变则不写盘、不重配置', async () => {
    const writes: boolean[] = []; const reconf: boolean[] = [];
    const s = svcWith(scriptedEngine([{ kind: 'none' }]), {
      persistAutoCheck: async (v) => { writes.push(v); },
      onAutoCheckChanged: (v) => { reconf.push(v); },
    });
    await s.setAutoCheck(true);
    expect(writes).toEqual([]); expect(reconf).toEqual([]);
    await s.setAutoCheck(false);
    expect(writes).toEqual([false]); expect(reconf).toEqual([false]);
    expect(s.getStatus().autoCheck).toBe(false);
  });

  it('setAutoCheck：写盘失败则不重配置，内存值也不变', async () => {
    const reconf: boolean[] = [];
    const s = svcWith(scriptedEngine([{ kind: 'none' }]), {
      persistAutoCheck: async () => { throw new Error('disk full'); },
      onAutoCheckChanged: (v) => { reconf.push(v); },
    });
    await expect(s.setAutoCheck(false)).rejects.toThrow('disk full');
    expect(reconf).toEqual([]);
    expect(s.getStatus().autoCheck).toBe(true);
  });

  it('setAutoCheck 连点两次以最后一次为准，且写盘与重配置顺序一致', async () => {
    const writes: boolean[] = []; const reconf: boolean[] = [];
    const s = svcWith(scriptedEngine([{ kind: 'none' }]), {
      persistAutoCheck: async (v) => { writes.push(v); },
      onAutoCheckChanged: (v) => { reconf.push(v); },
    });
    await Promise.all([s.setAutoCheck(false), s.setAutoCheck(true)]);
    expect(s.getStatus().autoCheck).toBe(true);
    expect(writes).toEqual([false, true]);
    expect(reconf).toEqual([false, true]);
  });

  it('restartAndInstall 在非 downloaded 态被拒绝', async () => {
    const e = scriptedEngine([{ kind: 'available', candidateId: 'c1', label: 'v2' }]);
    const s = svcWith(e, {});
    await s.check();
    expect(() => s.quitAndInstall()).toThrow();
    expect(s.canOpenDownload()).toBe(true);
  });

  it('canOpenDownload 只在 available 态为真', async () => {
    const e = scriptedEngine([{ kind: 'downloaded', label: 'v2' }]);
    const s = svcWith(e, {});
    await s.check();
    expect(s.canOpenDownload()).toBe(false);
    expect(() => s.quitAndInstall()).not.toThrow();
  });
});

describe('UpdateService deadline 与引擎的接合处', () => {
  // 两个 task 各测了自己一半：引擎那边验了 signal 会透传给 fetch，
  // service 这边验了状态迁移，但没人验过「引擎真的挂住时，service 的
  // AbortController 会把它拉回来，并且之后还能再检查」。
  it('引擎悬挂时 service 的 deadline 中止它，且后续可重试', async () => {
    vi.useFakeTimers();
    let runs = 0;
    const engine: CheckEngine = {
      run: (signal) => {
        runs += 1;
        return new Promise<CheckOutcome>((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({ kind: 'failed', message: '请求超时', retry: 'allowed' }));
        });
      },
      onLateOutcome: () => {},
      quitAndInstall: () => {},
    };
    const s = svc(engine);
    const p = s.check();
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await p).check).toMatchObject({ phase: 'failed', retry: 'allowed' });

    // abort 是真取消，不像 Windows 那样要禁用整个进程
    const p2 = s.check();
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    await p2;
    vi.useRealTimers();
  });
});
