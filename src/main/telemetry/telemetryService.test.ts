import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { createTelemetryService } from './telemetryService';
import { ensureInstallId } from './installId';
import { FIRST_CHECK_DELAY_MS } from './constants';
import type { TelemetryState } from '../../shared/types';

let dir: string;
let saved: { state: TelemetryState; decidedAt: string | null }[];

function make(over: Partial<Parameters<typeof createTelemetryService>[0]> = {}) {
  saved = [];
  return createTelemetryService({
    canReachNetwork: true,
    canBeacon: true,
    initial: { state: 'undecided', decidedAt: null },
    save: async (t) => { saved.push(t); },
    forget: vi.fn().mockResolvedValue({ kind: 'confirmed' }),
    send: vi.fn().mockResolvedValue({ kind: 'sent' }),
    appVersion: '0.3.1',
    platform: 'darwin',
    arch: 'arm64',
    now: () => new Date('2026-08-05T10:00:00Z'),
    ...over,
  });
}

const idFile = () => path.join(dir, 'install-id');
const beaconFile = () => path.join(dir, 'last-beacon');

/** 把微任务队列推到底。整条路径上没有真实定时器，卡住的只可能是被 gate 挡住的那一步。 */
async function pump(n = 50): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// 必须把两个路径常量都重定向到临时目录 —— installId / schedule 不再接受 dir 参数，
// 漏掉任何一个都会让测试写进开发者真实的 ~/.kydog/，既污染真实数据又让断言必然失败
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'kydog-tsvc-'));
  vi.spyOn(paths, 'INSTALL_ID_FILE', 'get').mockReturnValue(path.join(dir, 'install-id'));
  vi.spyOn(paths, 'LAST_BEACON_FILE', 'get').mockReturnValue(path.join(dir, 'last-beacon'));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('enable', () => {
  it('先落盘再生成 ID', async () => {
    // 在 save 的那一刻回看磁盘：只断言「落盘了」+「ID 在了」两个终态的话，
    // 顺序反过来一样成立，看不出用户意图有没有先被记下来
    let idExistedAtSave: boolean | null = null;
    const s = make({ save: async (t) => { idExistedAtSave = existsSync(idFile()); saved.push(t); } });
    await s.enable();
    expect(saved[0]).toEqual({ state: 'enabled', decidedAt: '2026-08-05T10:00:00.000Z' });
    expect(idExistedAtSave).toBe(false);
    expect(existsSync(idFile())).toBe(true);
  });

  // decidedAt 记的是「用户何时做出这个决定」，一次无意义的重复点击不该把它抹掉
  it('已是 enabled 时重复调用不改写 decidedAt，也不再写盘', async () => {
    const s = make({ initial: { state: 'enabled', decidedAt: '2026-01-01T00:00:00.000Z' } });
    await s.enable();
    expect(saved).toEqual([]);
    expect(s.state()).toBe('enabled');
  });

  // 删除失败却照样 enable，会复用磁盘上的旧 ID —— 等于静默撤销一个已发出的删除请求
  it('deleting 期间删除失败时不得转成 enabled', async () => {
    const s = make({
      initial: { state: 'deleting', decidedAt: null },
      forget: vi.fn().mockResolvedValue({ kind: 'failed', reason: 'offline' }),
    });
    const old = ensureInstallId();
    await s.enable();
    expect(s.state()).toBe('deleting');
    expect(saved).toEqual([]);
    expect(readFileSync(idFile(), 'utf8')).toBe(old);
  });

  it('落盘失败则不生成 ID —— 用户意图不能丢在磁盘之外', async () => {
    const s = make({ save: async () => { throw new Error('EIO'); } });
    await s.enable();
    expect(existsSync(idFile())).toBe(false);
  });
});

describe('disable', () => {
  it('先写 deleting，确认后才落 disabled 并删本地文件', async () => {
    // 断言落盘与出网的**交错顺序**，而不是 saved 的最终快照：把 persist(deleting)
    // 挪到 finishDelete() 之后，最终快照仍是 ['deleting','disabled'] 一模一样，
    // 只有事件序列能看出「先落盘、后动作」已经被破坏
    const events: string[] = [];
    const s = make({
      initial: { state: 'enabled', decidedAt: null },
      save: async (t) => { events.push(`save:${t.state}`); },
      forget: vi.fn().mockImplementation(async () => { events.push('forget'); return { kind: 'confirmed' }; }),
    });
    ensureInstallId();
    await s.disable();
    expect(events).toEqual(['save:deleting', 'forget', 'save:disabled']);
    expect(existsSync(idFile())).toBe(false);
    expect(existsSync(beaconFile())).toBe(false);
  });

  // 立刻丢弃 ID 意味着此后永远无法重试删除：用户以为删了，实际留在库里且再也删不掉
  it('forget 失败时停在 deleting，本地 ID 保留', async () => {
    const s = make({
      initial: { state: 'enabled', decidedAt: null },
      forget: vi.fn().mockResolvedValue({ kind: 'failed', reason: 'offline' }),
    });
    ensureInstallId();
    await s.disable();
    expect(saved.map((x) => x.state)).toEqual(['deleting']);
    expect(existsSync(idFile())).toBe(true);
    expect(s.state()).toBe('deleting');
  });

  it('deleting 状态下启动时自动重试', async () => {
    const forget = vi.fn().mockResolvedValue({ kind: 'confirmed' });
    const s = make({ initial: { state: 'deleting', decidedAt: null }, forget });
    ensureInstallId();
    await s.init();
    expect(forget).toHaveBeenCalledTimes(1);
    expect(s.state()).toBe('disabled');
    expect(existsSync(idFile())).toBe(false);
  });
});

describe('init', () => {
  // 与 deleteMyData 的守卫同源：启动时只有 enabled 才起调度。少了这个判断，
  // 一个从未同意（undecided）或明确关掉（disabled）的用户会在启动时被生成 ID 并开始上报
  it.each(['undecided', 'disabled'] as const)('%s 状态下不起调度、不生成 ID', async (state) => {
    const send = vi.fn().mockResolvedValue({ kind: 'sent' });
    const s = make({ initial: { state, decidedAt: null }, send });
    await s.init();
    expect(s.state()).toBe(state);
    expect(existsSync(idFile())).toBe(false);
    expect(s.currentId()).toBeNull();
  });

  describe('enabled（fake timers）', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    // 「用户已同意、重启后继续上报」的主路径。这里回归的症状是「装了就再也不上报了」，
    // 静默且永远发现不了 —— 服务端只会看到一条曲线慢慢变平
    it('已同意的用户重启后继续上报', async () => {
      const send = vi.fn().mockResolvedValue({ kind: 'sent' });
      const s = make({ initial: { state: 'enabled', decidedAt: null }, send });
      await s.init();
      expect(s.currentId()).not.toBeNull();
      expect(existsSync(idFile())).toBe(true);

      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
      // 连 id 一起断言：闭包读外层 let id 的话，clearLocal() 之后会发出 id: null
      expect(send).toHaveBeenCalledWith({
        id: s.currentId(), platform: 'darwin', arch: 'arm64', version: '0.3.1',
      });
    });

    it('重复 init 不排出第二组定时器', async () => {
      // send 卡在 gate 上：立即 resolve 的话第二组会被「今天已发过」去重掩盖掉
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const send = vi.fn().mockImplementation(async () => { await gate; return { kind: 'sent' as const }; });
      const s = make({ initial: { state: 'enabled', decidedAt: null }, send });
      await s.init();
      await s.init();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
      expect(send).toHaveBeenCalledTimes(1);
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
  });
});

describe('删除前先停调度并等在途 beacon（fake timers）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // 删除竞态三重防护的第 2 条：心跳若落在 forget 之后，那行数据会在客户端
  // 已丢弃 ID 之后才落库 —— 从此没有任何 ID 能指定它，永远删不掉
  it('disable 在在途 beacon 结束之后才发 forget', async () => {
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const send = vi.fn().mockImplementation(async () => {
      events.push('beacon:start');
      await gate;
      events.push('beacon:end');
      return { kind: 'sent' as const };
    });
    const forget = vi.fn().mockImplementation(async () => {
      events.push('forget');
      return { kind: 'confirmed' as const };
    });
    const s = make({ initial: { state: 'enabled', decidedAt: null }, send, forget });
    await s.init();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
    expect(events).toEqual(['beacon:start']);

    const stopping = s.disable();
    await pump();
    expect(forget).not.toHaveBeenCalled(); // 还卡在等那条在途 beacon

    release();
    await stopping;
    expect(events).toEqual(['beacon:start', 'beacon:end', 'forget']);
  });
});

describe('四个入口串行化', () => {
  // 交错执行会泄漏一个活着的 schedule：第二次 enable 建的那个出生在 disable 的
  // stopSchedule() 之后，此后再没有任何东西 stop 它，而磁盘和内存都说 disabled
  it('disable 在途时点 enable：forget 只发一次，终态 enabled 且 ID 真实存在', async () => {
    let release!: (v: { kind: 'confirmed' }) => void;
    const pending = new Promise<{ kind: 'confirmed' }>((r) => { release = r; });
    const forget = vi.fn().mockReturnValue(pending);
    const s = make({ initial: { state: 'enabled', decidedAt: null }, forget });
    await s.init();

    const disabling = s.disable();
    await pump();
    expect(forget).toHaveBeenCalledTimes(1); // disable 已停在这里等确认
    const enabling = s.enable();             // 用户觉得卡住，点了开启

    release({ kind: 'confirmed' });
    await Promise.all([disabling, enabling]);

    expect(forget).toHaveBeenCalledTimes(1);
    expect(s.state()).toBe('enabled');
    expect(s.currentId()).not.toBeNull();
    expect(readFileSync(idFile(), 'utf8')).toBe(s.currentId());
  });
});

describe('deleting 期间重新开启', () => {
  // 删除请求已经发出，必须被兑现；沿用旧 ID 等于撤销一个已发出的删除请求
  it('先完成删除，再生成一个不同的新 ID', async () => {
    const s = make({ initial: { state: 'deleting', decidedAt: null } });
    const old = ensureInstallId();
    await s.enable();
    expect(s.state()).toBe('enabled');
    const fresh = ensureInstallId();
    expect(fresh).not.toBe(old);
  });
});

describe('deleteMyData（保持参与）', () => {
  // tombstone 是永久的：旧 ID 已被抑制，不换新 ID 此后永远不会被记录
  it('确认后轮换新 ID，状态保持 enabled', async () => {
    const s = make({ initial: { state: 'enabled', decidedAt: null } });
    const old = ensureInstallId();
    await s.deleteMyData();
    expect(s.state()).toBe('enabled');
    expect(ensureInstallId()).not.toBe(old);
  });

  // UI 今天到不了这条路径（删除按钮只在有 ID 时显示），但 IPC 方法是无条件暴露的：
  // 不看状态就 startSchedule() 等于给一个明确关掉统计的用户重新开了上报
  it('disabled 状态下调用不会重新开始上报', async () => {
    const s = make({ initial: { state: 'disabled', decidedAt: null } });
    await s.deleteMyData();
    expect(s.state()).toBe('disabled');
    expect(existsSync(idFile())).toBe(false);
  });

  describe('forget 失败（fake timers）', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    // serverStateCleared() 已经把调度停了，不拉回来的话本次会话彻底不发心跳，
    // 而 enable() 的早退让用户点「开启」也恢复不了 —— 功能静默降级到重启为止。
    // 语义上也该重启：什么都没删掉，用户仍是 enabled，那就该继续上报
    it('调度仍在跑，用户可以再点一次重试', async () => {
      const send = vi.fn().mockResolvedValue({ kind: 'sent' });
      const s = make({
        initial: { state: 'enabled', decidedAt: null },
        send,
        forget: vi.fn().mockResolvedValue({ kind: 'failed', reason: 'offline' }),
      });
      await s.init();
      const old = s.currentId();
      await s.deleteMyData();

      expect(s.state()).toBe('enabled');
      expect(s.currentId()).toBe(old); // 沿用旧 ID 才诚实：数据还在服务端
      expect(readFileSync(idFile(), 'utf8')).toBe(old);

      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ id: old }));
    });
  });

  it('失败时保留旧 ID，不轮换', async () => {
    const s = make({
      initial: { state: 'enabled', decidedAt: null },
      forget: vi.fn().mockResolvedValue({ kind: 'failed', reason: 'offline' }),
    });
    const old = ensureInstallId();
    await s.deleteMyData();
    expect(ensureInstallId()).toBe(old);
  });
});

describe('闸门', () => {
  // 「闸优先于用户设置」这个不变量只能在这一层测到 —— telemetryAllowed 本身
  // 不接受用户设置入参，gate.test.ts 结构上测不了它。别以为那边已经覆盖了。
  it('闸门全关时不发送，也不生成 ID', async () => {
    const send = vi.fn();
    const s = make({ canReachNetwork: false, canBeacon: false, send });
    await s.enable();
    await s.init();
    expect(send).not.toHaveBeenCalled();
    expect(existsSync(idFile())).toBe(false);
  });

  // 闸门必须覆盖每一条出网路径，不只是 enable/init。曾经的写法在 runForget 里
  // 用 ensureInstallId()，开发态下点关闭会凭空造出一个标识并为它发一次删除请求。
  it('出网关闭且磁盘上本来就没有 ID 时，disable 不造 ID，直接落 disabled', async () => {
    const forget = vi.fn().mockResolvedValue({ kind: 'confirmed' });
    const s = make({ canReachNetwork: false, canBeacon: false, forget, initial: { state: 'enabled', decidedAt: null } });
    await s.disable();
    expect(forget).not.toHaveBeenCalled();
    expect(existsSync(idFile())).toBe(false);
    expect(s.state()).toBe('disabled');
  });

  // paths.ROOT 是 ~/.kydog，开发态与正式版共用：这台机器装过正式版并开过统计的话，
  // npm start 点一下关闭就会拿真实生产 ID 发真实删除请求、并删掉真实文件。
  // 但删除请求也不能被静默丢弃 —— 停在 deleting，等打包版启动时由 init() 兑现。
  it('出网关闭但磁盘上真有 ID 时，不出网且停在 deleting', async () => {
    const forget = vi.fn().mockResolvedValue({ kind: 'confirmed' });
    const s = make({ canReachNetwork: false, canBeacon: false, forget, initial: { state: 'enabled', decidedAt: null } });
    const old = ensureInstallId();
    await s.disable();
    expect(forget).not.toHaveBeenCalled();
    expect(s.state()).toBe('deleting');
    expect(readFileSync(idFile(), 'utf8')).toBe(old); // 保留，才能在打包版里重试
  });

  // 本地没有 ID 就没有要删的东西，不该发一个服务端从没见过的删除请求。
  // 但「删数据且继续参与」的语义要求之后仍要有一个新 ID —— 两件事都要断言。
  it('本来就没有 ID 时，deleteMyData 不发请求，但仍会为继续参与建立新 ID', async () => {
    const forget = vi.fn().mockResolvedValue({ kind: 'confirmed' });
    const s = make({ forget, initial: { state: 'enabled', decidedAt: null } });
    await s.deleteMyData();
    expect(forget).not.toHaveBeenCalled();
    expect(s.state()).toBe('enabled');
    expect(existsSync(idFile())).toBe(true);
  });
});

// canBeacon 关而 canReachNetwork 开 = 打包版但版本非法 / 平台不在枚举内。
// 与开发态的区别是**永久性**：这个构建永远发不出 beacon，不存在「以后能发的上下文」。
// forget 的 payload 只有 {id}，与版本、平台毫无关系 —— 两道闸必须分开，
// 否则用户会永远冻在 deleting。UI 那侧同一条约定：canBeacon 只管开启方向，
// 关闭方向永远可用（见 PrivacyPanel.test.ts 的半开态用例）。
describe('两道闸分开：canBeacon 关但 canReachNetwork 开', () => {
  const halfOpen = { canReachNetwork: true, canBeacon: false } as const;

  it('deleting 状态下 init() 照常兑现删除，落到 disabled 而不是永久冻结', async () => {
    const forget = vi.fn().mockResolvedValue({ kind: 'confirmed' });
    const s = make({ ...halfOpen, forget, initial: { state: 'deleting', decidedAt: null } });
    ensureInstallId();
    await s.init();
    expect(forget).toHaveBeenCalledTimes(1);
    expect(s.state()).toBe('disabled');
    expect(existsSync(idFile())).toBe(false);
  });

  it('disable() 能真删除并收尾 —— 用户仍有退出的路', async () => {
    const forget = vi.fn().mockResolvedValue({ kind: 'confirmed' });
    const s = make({ ...halfOpen, forget, initial: { state: 'enabled', decidedAt: null } });
    const old = ensureInstallId();
    await s.disable();
    expect(forget).toHaveBeenCalledWith(old);
    expect(s.state()).toBe('disabled');
    expect(existsSync(idFile())).toBe(false);
  });

  describe('（fake timers）', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('enabled 状态下 init() 不起调度、不生成 ID', async () => {
      const send = vi.fn().mockResolvedValue({ kind: 'sent' });
      const s = make({ ...halfOpen, send, initial: { state: 'enabled', decidedAt: null } });
      await s.init();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
      expect(send).not.toHaveBeenCalled();
      expect(existsSync(idFile())).toBe(false);
    });

    // platform/arch 为 null 时绝不能有任何东西被发出去。守卫在这里而不是靠
    // 「assemble.ts 保证 canBeacon 蕴含二者非 null」这条非局部不变量撑着。
    it.each([
      ['platform', { platform: null }],
      ['arch', { arch: null }],
    ] as const)('%s 为 null 时即使 canBeacon 为真也不起调度', async (_name, over) => {
      const send = vi.fn().mockResolvedValue({ kind: 'sent' });
      const s = make({ ...over, send, initial: { state: 'enabled', decidedAt: null } });
      await s.init();
      await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
      expect(send).not.toHaveBeenCalled();
      expect(existsSync(idFile())).toBe(false);
    });
  });
});

// deleting 是个能停住的状态（forget 失败就停在这里），必须有一条干净的收尾路径，
// 否则用户卡在「正在删除」而没有任何按钮能推进。设置页的「关闭统计」直接用 disable()。
describe('deleting 的重试入口', () => {
  it('disable() 在已是 deleting 时不改写 decidedAt，直接收尾', async () => {
    const forget = vi.fn().mockResolvedValue({ kind: 'confirmed' });
    const s = make({ forget, initial: { state: 'deleting', decidedAt: '2026-01-01T00:00:00.000Z' } });
    ensureInstallId();
    await s.disable();
    // 重写 decidedAt 等于把「重试收尾」谎报成一个新决定
    expect(saved).toEqual([{ state: 'disabled', decidedAt: '2026-01-01T00:00:00.000Z' }]);
    expect(s.state()).toBe('disabled');
    expect(existsSync(idFile())).toBe(false);
  });

  // 守 deleting 一个不够：面板进来会自动重试一次，用户手上还有「立即重试」那个按钮，
  // 第二次到达时状态很可能已经是 disabled。那时用 now() 重写 decidedAt，就把
  // 「用户何时按下关闭」这条事实抹成了「他刚刚才关」—— 与 enable() 保护原始同意
  // 时间同一条约定，deleting 与 disabled 都不是新决定。
  it('disable() 从 disabled 进来同样不改写 decidedAt', async () => {
    const forget = vi.fn().mockResolvedValue({ kind: 'confirmed' });
    const s = make({ forget, initial: { state: 'disabled', decidedAt: '2026-01-01T00:00:00.000Z' } });
    await s.disable();
    expect(saved.some((x) => x.state === 'deleting')).toBe(false);
    expect(saved.every((x) => x.decidedAt === '2026-01-01T00:00:00.000Z')).toBe(true);
    expect(s.state()).toBe('disabled');
  });

  // undecided → 关闭确实是一个新决定，这条守着上面那个守卫别收得过宽
  it('disable() 从 undecided 进来是新决定，decidedAt 取 now()', async () => {
    const s = make({ initial: { state: 'undecided', decidedAt: null } });
    await s.disable();
    expect(saved.map((x) => x.state)).toEqual(['deleting', 'disabled']);
    expect(saved[0].decidedAt).toBe('2026-08-05T10:00:00.000Z');
  });

  // 曾经的写法把状态守卫放在 clearLocal() 之后：本地 ID 被删掉、state 仍是 deleting、
  // save 一次没调 —— 本会话再也回不到 disabled，服务端那份数据也永远没人来删
  it('deleteMyData() 在 deleting 下什么都不做，本地 ID 必须留着', async () => {
    const forget = vi.fn().mockResolvedValue({ kind: 'confirmed' });
    const s = make({ forget, initial: { state: 'deleting', decidedAt: null } });
    const old = ensureInstallId();
    await s.deleteMyData();
    expect(forget).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
    expect(s.state()).toBe('deleting');
    expect(readFileSync(idFile(), 'utf8')).toBe(old);
  });
});

// 面板是被动的：它进来时看到的 deleting，可能是启动时那次 fire-and-forget 的重试
// 还在飞。没有这条通知，那句「删除请求尚未完成」就再也不会被纠正 —— 而撞上它的
// 恰好是网络不稳的那批用户（他们本来就是因此才停在 deleting 的）。
describe('状态变更通知', () => {
  type Seen = { state: TelemetryState; installId: string | null };
  const collect = () => {
    const seen: Seen[] = [];
    return { seen, onChange: (s: Seen) => { seen.push(s); } };
  };

  it('deleting 期间删除兑现 → 最后一条通知是 disabled，不是停在 deleting', async () => {
    const { seen, onChange } = collect();
    const s = make({ initial: { state: 'deleting', decidedAt: null }, onChange });
    ensureInstallId();
    await s.init();
    expect(s.state()).toBe('disabled');
    expect(seen.at(-1)).toEqual({ state: 'disabled', installId: null });
  });

  // 通知里必须带 ID：面板显示的是标识，只报 state 的话，enable() 之后那串前 8 位
  // 永远推不出去（它是在 persist 之后才由 startSchedule 生成的）。
  it('enable 生成 ID 后再通知一次，带上新标识', async () => {
    const { seen, onChange } = collect();
    const s = make({ onChange });
    await s.enable();
    expect(seen.map((x) => x.state)).toEqual(['enabled', 'enabled']);
    expect(seen[0].installId).toBeNull();          // 落盘那一刻还没有 ID
    expect(seen.at(-1)!.installId).toBe(s.currentId());
    expect(s.currentId()).not.toBeNull();
  });

  it('清本地 ID 也要通知：UI 上那串标识得跟着消失', async () => {
    const { seen, onChange } = collect();
    const s = make({ initial: { state: 'enabled', decidedAt: null }, onChange });
    ensureInstallId();
    await s.disable();
    expect(seen.map((x) => x.state)).toEqual(['deleting', 'deleting', 'deleting', 'disabled']);
    //                                          落盘      回填 ID    清 ID
    expect(seen[1].installId).not.toBeNull();
    expect(seen[2].installId).toBeNull();
  });

  it('落盘失败一次都不通知 —— 通知出去就是把一个没发生的变化告诉了 UI', async () => {
    const { seen, onChange } = collect();
    const s = make({ save: async () => { throw new Error('EIO'); }, onChange });
    await s.enable();
    expect(seen).toEqual([]);
  });

  it('syncFromSettings 也通知：onboarding 勾完，设置页得看到已开启', async () => {
    const { seen, onChange } = collect();
    const s = make({ onChange });
    await s.syncFromSettings({ state: 'enabled', decidedAt: '2026-08-05T09:00:00.000Z' });
    expect(seen.map((x) => x.state)).toEqual(['enabled', 'enabled']);
    expect(seen.at(-1)!.installId).toBe(s.currentId());
  });
});

describe('syncFromSettings（onboarding 落盘后的同步）', () => {
  it('undecided 收到 enabled → 起调度、生成 ID、state 跟着变', async () => {
    const s = make();
    expect(s.state()).toBe('undecided');
    await s.syncFromSettings({ state: 'enabled', decidedAt: '2026-08-05T09:00:00.000Z' });
    expect(s.state()).toBe('enabled');
    expect(existsSync(idFile())).toBe(true);
    expect(s.currentId()).not.toBeNull();
  });

  it('收到 disabled → 不起调度、不生成 ID、不写盘', async () => {
    const forget = vi.fn().mockResolvedValue({ kind: 'confirmed' });
    const s = make({ forget });
    await s.syncFromSettings({ state: 'disabled', decidedAt: '2026-08-05T09:00:00.000Z' });
    expect(s.state()).toBe('disabled');
    expect(existsSync(idFile())).toBe(false);
    expect(s.currentId()).toBeNull();
    // 复用 disable() 会在这里写两次盘（deleting → disabled），且用 now() 改写 decidedAt
    expect(saved).toEqual([]);
    expect(forget).not.toHaveBeenCalled();
  });

  // 上一条的 forget 断言其实拦不住 disable()：没有 ID 时 serverStateCleared() 早退，
  // 它压根走不到 forget。要真拦住复用 disable() 这个改法，磁盘上得先有个 ID。
  // syncFromSettings 是「把已经落好盘的选择告诉服务」，它不该有任何删除语义。
  it('磁盘上已有 ID 时收到 disabled：不发删除请求，也不动本地 ID', async () => {
    const forget = vi.fn().mockResolvedValue({ kind: 'confirmed' });
    const s = make({ forget });
    const existing = ensureInstallId();
    await s.syncFromSettings({ state: 'disabled', decidedAt: '2026-08-05T09:00:00.000Z' });
    expect(forget).not.toHaveBeenCalled();
    expect(readFileSync(idFile(), 'utf8')).toBe(existing);
    expect(saved).toEqual([]);
  });

  // 落盘是 onboardingService 的事。这里一写盘，就说明要么 persist 了、要么复用了
  // enable() —— 两者都会用 now() 把 manifest 里那个权威的 decidedAt 覆盖掉。
  it('一次都不回写磁盘', async () => {
    const s = make();
    await s.syncFromSettings({ state: 'enabled', decidedAt: '2019-03-04T05:06:07.000Z' });
    expect(saved).toEqual([]);
    // 已是 enabled，enable() 早退不写盘 —— 顺带证明 state 确实被采纳了
    await s.enable();
    expect(saved).toEqual([]);
  });

  // 上一条只能证明「没写盘」，证明不了内部记下的是哪个值。disable() 从 deleting 进去会
  // 跳过 persist('deleting')，最终那条 disabled 记录带的就是服务内部的 decidedAt ——
  // syncFromSettings 若用 now() 覆盖过它，这里就露馅。
  it('内部记下的就是传进来的 decidedAt，不是 now()', async () => {
    const s = make({ forget: vi.fn().mockResolvedValue({ kind: 'confirmed' }) });
    ensureInstallId();
    const decidedAt = '2019-03-04T05:06:07.000Z';   // 与 now() 的 2026-08-05T10:00:00Z 明显不同
    await s.syncFromSettings({ state: 'deleting', decidedAt });
    await s.disable();
    expect(saved).toEqual([{ state: 'disabled', decidedAt }]);
  });
});
