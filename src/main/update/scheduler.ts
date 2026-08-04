export interface Scheduler {
  /** 开→关：清掉待触发的 timer；关→开：重新安排首检并恢复周期。 */
  reconfigure(enabled: boolean): void;
  stop(): void;
}

/** 只管定时，不懂更新语义。节流状态不跨进程持久化 ——
 *  桌面应用的启动频率本身就是天然节流，存「上次检查时间」只增加状态。 */
export function createScheduler(deps: {
  run: () => Promise<unknown>;
  firstDelayMs: number;
  intervalMs: number;
}): Scheduler {
  let first: ReturnType<typeof setTimeout> | null = null;
  let repeat: ReturnType<typeof setInterval> | null = null;

  const clear = () => {
    if (first) { clearTimeout(first); first = null; }
    if (repeat) { clearInterval(repeat); repeat = null; }
  };

  return {
    reconfigure(enabled) {
      clear();
      if (!enabled) return;
      first = setTimeout(() => {
        void deps.run();
        repeat = setInterval(() => { void deps.run(); }, deps.intervalMs);
      }, deps.firstDelayMs);
    },
    stop: clear,
  };
}
