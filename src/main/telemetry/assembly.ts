/** 开发态与 e2e 的唯一闸门。此判断优先于用户设置 —— 用户在 npm start 下把开关
 *  打开也不发。闸只此一处，schedule 与任何手动触发同受其管。
 *
 *  与 update/pickAssembly.ts 是同一个意图的两份实现：统计与更新已刻意解耦，
 *  不共用那道闸，因此这里必须自建，不能假设更新那边挡住了。 */
export function telemetryAllowed(env: { isPackaged: boolean; e2e?: string }): boolean {
  if (env.e2e === '1') return false;
  return env.isPackaged;
}
