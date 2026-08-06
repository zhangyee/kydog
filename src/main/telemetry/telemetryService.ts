import { ensureInstallId, readInstallId, dropInstallId } from './installId';
import { createSchedule, dropLastBeacon, type Schedule } from './schedule';
import type { BeaconOutcome, ForgetOutcome } from './transport';
import type { Arch, Platform } from '../../shared/telemetryContract';
import type { TelemetryState } from '../../shared/types';

export type TelemetrySettings = { state: TelemetryState; decidedAt: string | null };

export type TelemetryService = {
  /** 启动时调一次：按落盘状态决定是否起调度，并重试未完成的删除。 */
  init(): Promise<void>;
  enable(): Promise<void>;
  disable(): Promise<void>;
  /** 删除已上报的数据但继续参与统计。成功后必须轮换新 ID。 */
  deleteMyData(): Promise<void>;
  /** onboarding 落盘后把用户的选择同步进运行中的服务。装配发生在启动时（那会儿还是
   *  undecided），不同步的话勾选在本次会话完全不生效：不起调度、不生成 ID，设置页
   *  还会显示成未勾选。
   *  不 persist —— onboardingService 已经写过了；而且 manifest 里的 decidedAt 才是权威的
   *  （Task 6 专门把选择写进了播种记录），复用 enable() 会用 now() 把它覆盖掉。
   *  取消勾选时也不该走 disable()：那会为一个从没发送过任何东西的安装发一次删除请求。 */
  syncFromSettings(next: TelemetrySettings): Promise<void>;
  state(): TelemetryState;
  currentId(): string | null;
};

export function createTelemetryService(deps: {
  /** 能不能出网。守 forget 路径 —— forget 的 payload 只有 {id}，与版本、平台无关。
   *  只有开发态/e2e 会关掉它，而开发态是**暂时**的，所以「停在 deleting、等打包版
   *  启动时兑现」成立。 */
  canReachNetwork: boolean;
  /** 能不能发 beacon。守 startSchedule()。版本非法 / 平台不在枚举内是这个构建的
   *  **永久**属性，不存在「以后能发的上下文」—— 与 canReachNetwork 合成一个布尔的话，
   *  这类用户会永远冻在 deleting 且没有重试入口。 */
  canBeacon: boolean;
  initial: TelemetrySettings;
  save(t: TelemetrySettings): Promise<void>;
  forget(id: string): Promise<ForgetOutcome>;
  send(payload: {
    id: string; platform: Platform; arch: Arch; version: string;
  }): Promise<BeaconOutcome>;
  appVersion: string;
  /** 不在契约枚举内时为 null。绝不接受 'darwin' 这种占位值 —— 一个编造的值一旦被
   *  物化，就只剩注释和另一个模块的非局部不变量拦着它进 payload。 */
  platform: Platform | null;
  arch: Arch | null;
  /** 状态或标识一变就调一次，用于把变化推给渲染层。UI 显示的是 (state, id) 这一对，
   *  所以两者各自都算变化 —— 只盯 state 的话，enable() 之后生成的 ID 永远推不出去。
   *  必须是**推**而不是让 UI 轮询：启动时那次删除重试是 fire-and-forget，窗口开出来
   *  时它可能还在飞，面板拿到的 deleting 之后再也没有第二次机会被纠正。 */
  onChange?: (s: { state: TelemetryState; installId: string | null }) => void;
  now?: () => Date;
}): TelemetryService {
  // 不接 dir 参数：installId / schedule 直接用 paths 常量，测试靠 vi.spyOn 重定向
  const now = deps.now ?? (() => new Date());
  let cur = deps.initial;
  let schedule: Schedule | null = null;
  let id: string | null = null;

  function notify(): void {
    deps.onChange?.({ state: cur.state, installId: id });
  }

  /** cur 与 id 只经由这两个函数改写。通知挂在赋值上而不是挂在四个入口的出口 ——
   *  入口在途中就会变（disable 先落 deleting，再等 forget 回来），只在出口发的话，
   *  恰好在这段时间里打开面板的用户看到的就是一个再也不会被纠正的中间态。 */
  function setCur(next: TelemetrySettings): void { cur = next; notify(); }
  function setId(next: string | null): void {
    if (next === id) return;
    id = next;
    notify();
  }

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
    // setCur 放在 try 外：通知里抛出的异常不该把一次已经落盘成功的写入报成失败
    try { await deps.save(next); } catch { return false; }
    setCur(next);
    return true;
  }

  function startSchedule(): void {
    // platform/arch 一并守在这里：canBeacon 蕴含二者非 null 是 assemble.ts 的
    // 不变量，但那是非局部的，不能靠它把 null 挡在 payload 之外
    const beaconPlatform = deps.platform;
    const beaconArch = deps.arch;
    if (!deps.canBeacon || !beaconPlatform || !beaconArch || schedule) return;
    // 捕获成局部常量：闭包若读外层的 id，读到的是**当前值**，clearLocal() 之后
    // 就是 null，而 id! 会把这个谎言原样带进 payload（实测发出过 {"id":null,...}）
    const beaconId = ensureInstallId();
    setId(beaconId);
    schedule = createSchedule({
      now,
      send: () => deps.send({ id: beaconId, platform: beaconPlatform, arch: beaconArch, version: deps.appVersion }),
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
    // 并在开发态（canReachNetwork=false，从未生成过 ID）下产生一次本不该有的网络调用。
    const target = id ?? readInstallId();
    if (!target) return true; // 没有要删的东西 = 已经删完了
    setId(target); // 回填：否则磁盘有 ID 而 currentId() 返回 null，UI 显示不出来
    // 闸门：开发态/e2e 绝不出网。但删除请求不能被静默丢弃 —— 停在 deleting，
    // 等下次在打包版里启动时由 init() 真正完成。deleting 的语义本就是
    // 「请求未确认，持续重试」，推迟到能发的上下文正是它该做的事。
    // 判断顺序不可换：先「有没有东西要删」再「能不能出网」，否则全新 HOME 的
    // e2e 会卡在 deleting；只有「开发态 + 磁盘上真有 ID」才该停下来等。
    // 用 canReachNetwork 而不是 canBeacon：版本非法的构建照样能、也必须能删数据。
    if (!deps.canReachNetwork) return false;
    const r = await deps.forget(target);
    return r.kind === 'confirmed';
  }

  function clearLocal(): void {
    dropInstallId();
    dropLastBeacon();
    setId(null);
  }

  async function finishDelete(): Promise<boolean> {
    if (!(await serverStateCleared())) return false;
    clearLocal();
    return true;
  }

  return {
    init: () => serialize(async () => {
      // 这里守的是 forget 重试那条路；起调度那条另有 startSchedule() 的 canBeacon 闸
      if (!deps.canReachNetwork) return;
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
      // 只有「还没决定关」的两个状态进来才算一个新决定。deleting 是重试收尾，
      // disabled 是已经关掉了（面板进来自动重试、用户又点一次「立即重试」，第二次
      // 到达时状态已经是 disabled），两者都不该用 now() 抹掉用户最初按下关闭的时间
      // —— 与 enable() 保护原始同意时间同一条约定。
      // 这也让 disable() 成为 deleting 的干净重试入口（面板的重试直接用它）。
      if (cur.state === 'enabled' || cur.state === 'undecided') {
        if (!(await persist({ state: 'deleting', decidedAt: now().toISOString() }))) return;
      }
      if (!(await finishDelete())) return;   // 停在 deleting，下次 init 重试
      await persist({ state: 'disabled', decidedAt: cur.decidedAt });
    }),

    deleteMyData: () => serialize(async () => {
      // 状态守卫必须在**做任何事之前**。放在 finishDelete() 之后的话，从 deleting
      // 进来会先把本地 ID 删掉再早退：state 仍是 deleting、save 一次没调，本会话
      // 再也回不到 disabled，服务端那份数据也没人来删了。
      // 「删数据但继续参与」只对 enabled 成立；disabled/undecided 下重启上报等于
      // 给一个明确关掉统计的用户重新开了口子 —— UI 今天到不了这里，但 IPC 是
      // 无条件暴露的。要收尾一个 deleting，走 disable()。
      if (cur.state !== 'enabled') return;
      // 成败都要把被 serverStateCleared() 停掉的调度拉回来 —— 用户仍是 enabled。
      // 成功：本地 ID 已清，这里会生成新 ID（tombstone 永久，旧 ID 已被抑制，
      //   不换新 ID 的话「继续参与」的后半句永远不会兑现）。
      // 失败：沿用旧 ID 才诚实，什么都没删掉，用户可以再点一次重试；不拉回调度
      //   则本次会话彻底不发心跳，而 enable() 的早退让用户自己也恢复不了。
      await finishDelete();
      startSchedule();
    }),

    // 与其余四个入口同一条链：并发时交错执行同样会泄漏一个活着的 schedule。
    syncFromSettings: (next) => serialize(async () => {
      setCur(next);                                // 直接采纳，不落盘也不改 decidedAt
      if (next.state === 'enabled') startSchedule();
      else await stopSchedule();
    }),

    state: () => cur.state,
    currentId: () => id,
  };
}
