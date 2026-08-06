import { ensureInstallId, readInstallId, dropInstallId } from './installId';
import { createSchedule, dropLastBeacon, type Schedule } from './schedule';
import type { BeaconOutcome, ForgetOutcome } from './transport';
import type { TelemetryState } from '../../shared/types';

export type TelemetrySettings = { state: TelemetryState; decidedAt: string | null };

export type TelemetryService = {
  /** 启动时调一次：按落盘状态决定是否起调度，并重试未完成的删除。 */
  init(): Promise<void>;
  enable(): Promise<void>;
  disable(): Promise<void>;
  /** 删除已上报的数据但继续参与统计。成功后必须轮换新 ID。 */
  deleteMyData(): Promise<void>;
  state(): TelemetryState;
  currentId(): string | null;
};

export function createTelemetryService(deps: {
  allowed: boolean;
  initial: TelemetrySettings;
  save(t: TelemetrySettings): Promise<void>;
  forget(id: string): Promise<ForgetOutcome>;
  send(payload: {
    id: string; platform: 'darwin' | 'win32'; arch: 'x64' | 'arm64'; version: string;
  }): Promise<BeaconOutcome>;
  appVersion: string;
  platform: 'darwin' | 'win32';
  arch: 'x64' | 'arm64';
  now?: () => Date;
}): TelemetryService {
  // 不接 dir 参数：installId / schedule 直接用 paths 常量，测试靠 vi.spyOn 重定向
  const now = deps.now ?? (() => new Date());
  let cur = deps.initial;
  let schedule: Schedule | null = null;
  let id: string | null = null;

  /** 四个入口串到一条链上。交错执行会泄漏一个活着的 schedule：并发
   *  disable + enable（用户觉得卡住又点开启）时，第二次 enable 建的 schedule
   *  出生在 disable 的 stopSchedule() 之后，此后再没有任何东西 stop 它 ——
   *  进程剩余生命周期里每 6 小时发一次 beacon，而磁盘和内存都说 disabled。 */
  let chain: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn);
    chain = next.then(() => undefined, () => undefined);
    return next;
  }

  /** 任何状态变更都是先落盘、后动作。顺序颠倒会丢失用户意图：
   *  若先删本地 ID 再写 disabled，进程在两者之间崩溃时磁盘仍是 enabled，
   *  重启即生成新 ID 重新上报。落盘失败就当什么都没发生。 */
  async function persist(next: TelemetrySettings): Promise<boolean> {
    try { await deps.save(next); cur = next; return true; }
    catch { return false; }
  }

  function startSchedule(): void {
    if (!deps.allowed || schedule) return;
    // 捕获成局部常量：闭包若读外层的 id，读到的是**当前值**，clearLocal() 之后
    // 就是 null，而 id! 会把这个谎言原样带进 payload（实测发出过 {"id":null,...}）
    const beaconId = ensureInstallId();
    id = beaconId;
    schedule = createSchedule({
      now,
      send: () => deps.send({ id: beaconId, platform: deps.platform, arch: deps.arch, version: deps.appVersion }),
    });
    schedule.start();
  }

  async function stopSchedule(): Promise<void> {
    if (!schedule) return;
    await schedule.stop();
    schedule = null;
  }

  /** 服务端那份数据是否已经不在了。true 有两种来路：确认删掉了，或本来就没有
   *  东西要删 —— 对调用方是同一件事，都意味着可以丢弃本地 ID 了。
   *  停调度 → 等在途 beacon 结束 → forget，这一串是删除竞态三重防护的第 2 条。 */
  async function serverStateCleared(): Promise<boolean> {
    await stopSchedule();
    // 只读不创建。用 ensureInstallId() 会凭空造出一个服务端从没见过的标识，
    // 并在开发态（allowed=false，从未生成过 ID）下产生一次本不该有的网络调用。
    const target = id ?? readInstallId();
    if (!target) return true; // 没有要删的东西 = 已经删完了
    id = target; // 回填：否则磁盘有 ID 而 currentId() 返回 null，UI 显示不出来
    // 闸门：开发态/e2e 绝不出网。但删除请求不能被静默丢弃 —— 停在 deleting，
    // 等下次在打包版里启动时由 init() 真正完成。deleting 的语义本就是
    // 「请求未确认，持续重试」，推迟到能发的上下文正是它该做的事。
    // 判断顺序不可换：先「有没有东西要删」再「能不能出网」，否则全新 HOME 的
    // e2e 会卡在 deleting；只有「开发态 + 磁盘上真有 ID」才该停下来等。
    if (!deps.allowed) return false;
    const r = await deps.forget(target);
    return r.kind === 'confirmed';
  }

  function clearLocal(): void {
    dropInstallId();
    dropLastBeacon();
    id = null;
  }

  async function finishDelete(): Promise<boolean> {
    if (!(await serverStateCleared())) return false;
    clearLocal();
    return true;
  }

  return {
    init: () => serialize(async () => {
      if (!deps.allowed) return;
      if (cur.state === 'deleting') {
        if (await finishDelete()) await persist({ state: 'disabled', decidedAt: cur.decidedAt });
        return;
      }
      if (cur.state === 'enabled') startSchedule();
    }),

    enable: () => serialize(async () => {
      // 重复点击不该抹掉原始同意时间 —— decidedAt 记的是「何时做出这个决定」
      if (cur.state === 'enabled') return;
      // 已请求的删除必须先兑现，否则等于撤销了一个已发出的删除请求
      if (cur.state === 'deleting' && !(await finishDelete())) return;
      if (!(await persist({ state: 'enabled', decidedAt: now().toISOString() }))) return;
      startSchedule();
    }),

    disable: () => serialize(async () => {
      if (!(await persist({ state: 'deleting', decidedAt: now().toISOString() }))) return;
      if (!(await finishDelete())) return;   // 停在 deleting，下次 init 重试
      await persist({ state: 'disabled', decidedAt: cur.decidedAt });
    }),

    deleteMyData: () => serialize(async () => {
      if (!(await finishDelete())) {
        // 删除失败但用户仍在参与：把被 serverStateCleared 停掉的调度拉回来。
        // 否则本次会话不再发心跳，而 enable() 的早退让用户没法自己恢复 ——
        // 功能静默降级到重启为止，比少一条数据糟。沿用旧 ID 是诚实的：
        // 什么都没删掉，数据还在服务端，用户可以再点一次重试。
        if (cur.state === 'enabled') startSchedule();
        return;
      }
      // 只在仍参与统计时重启。若在 disabled/undecided 下被调用还去 startSchedule()，
      // 就会给一个已明确关掉统计的用户生成新 ID 并重新开始上报 —— UI 今天到不了
      // 这条路径，但 IPC 方法是无条件暴露的，纵深防御守住。
      if (cur.state !== 'enabled') return;
      // tombstone 永久，旧 ID 已被抑制 —— 继续参与就必须换一个新 ID，
      // 否则「删数据但继续参与」的后半句永远不会兑现
      startSchedule();
    }),

    state: () => cur.state,
    currentId: () => id,
  };
}
