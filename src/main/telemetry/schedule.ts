// src/main/telemetry/schedule.ts
import { readFileSync, unlinkSync } from 'node:fs';
import { atomicWriteWith0600Sync } from '../persist/atomicWrite';
import * as paths from '../persist/paths';
import { FIRST_CHECK_DELAY_MS, CHECK_INTERVAL_MS } from './constants';
import type { BeaconOutcome } from './transport';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type Schedule = {
  /** 幂等：重复调用先清掉上一组定时器，否则旧的会永久空转。 */
  start(): void;
  checkOnce(): Promise<void>;
  /** 停止调度并等待**全部**在途请求结束 —— 关闭流程依赖它做串行化。
   *  一次性：stop() 之后本实例永久失效，重新开启请用 createSchedule 新建。 */
  stop(): Promise<void>;
};

export function createSchedule(deps: {
  send: () => Promise<BeaconOutcome>;
  now?: () => Date;
}): Schedule {
  const now = deps.now ?? (() => new Date());

  let stopped = false;
  let firstTimer: NodeJS.Timeout | null = null;
  let intervalTimer: NodeJS.Timeout | null = null;
  // 用 Set 而非单个变量：两次 checkOnce 并发时单槽会被覆盖，
  // stop() 就只等到最后一次，前一次的写入可能在关闭之后才落地
  const inflight = new Set<Promise<void>>();

  const today = () => now().toISOString().slice(0, 10);

  function lastSent(): string | null {
    try {
      const raw = readFileSync(paths.LAST_BEACON_FILE, 'utf8').trim();
      return ISO_DATE_RE.test(raw) ? raw : null;
    } catch { return null; }
  }

  function clearTimers(): void {
    if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
  }

  // 不加并发锁挡住同日内的重复 checkOnce 是刻意的：宁可多发一次、
  // 靠服务端主键去重，也不要为了「防重」引入一把锁又把 stop() 等不全的问题带回来。
  async function checkOnce(): Promise<void> {
    if (stopped) return;
    const day = today();
    // 严格不等：时钟回拨导致的「未来日期」也视为需发送，服务端主键会兜住重复
    if (lastSent() === day) return;

    // run 必须永不 reject：start() 里是 void checkOnce()，一次 reject 就是
    // 主进程的 unhandled rejection；而 inflight 里留着一个 rejected 的
    // promise 会让 stop() 跟着 reject，Task 7 的关闭串行化契约就断了。
    // 不能把「不会 reject」寄托在 deps.send 的下游契约上（呼应
    // update/scheduler.ts 对同一风险的判断）——整段兜底，不只兜写盘。
    const run = (async () => {
      try {
        const outcome = await deps.send();
        if (outcome.kind !== 'sent') return;
        atomicWriteWith0600Sync(paths.LAST_BEACON_FILE, day);
      } catch {
        // 发送或写盘失败一律视同未确认，下次检查重试。宁可多发一次，
        // 也不要让一次故障炸掉主进程 —— 重复由服务端主键兜住
      }
    })();
    inflight.add(run);
    try { await run; } finally { inflight.delete(run); }
  }

  return {
    start() {
      if (stopped) return;
      clearTimers(); // 幂等：不留下上一组空转的 timer
      firstTimer = setTimeout(() => { void checkOnce(); }, FIRST_CHECK_DELAY_MS);
      intervalTimer = setInterval(() => { void checkOnce(); }, CHECK_INTERVAL_MS);
    },
    checkOnce,
    async stop() {
      stopped = true;
      clearTimers();
      await Promise.all([...inflight]); // 展开成数组是快照，await 期间的 delete 不影响它
    },
  };
}

/** 关闭统计时连同日期一起清掉，避免重新开启时误判「今天已发过」。 */
export function dropLastBeacon(): void {
  try { unlinkSync(paths.LAST_BEACON_FILE); }
  catch { /* 已经没有就是想要的终态 */ }
}
