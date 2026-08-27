/**
 * ~/.kydog/skills/ 的串行闸门。所有读写 live tree 的入口都要经它，不止 resource loader：
 * skill.list / skill.openInOS / commitFromPreview / uninstall / 各处 sync / locale.set。
 *
 * 有一个入口**锁不住，也无法锁住**：模型用普通 read 工具读 SKILL.md 的那条路径。
 * 这正是 locale.set 必须先拒绝 active run、再 dispose 全部 session 的原因 ——
 * 锁解决不了的，用「切换时没有 run 在跑」这个前提解决。
 */
let chain: Promise<unknown> = Promise.resolve();

export function withSkillTree<T>(fn: () => Promise<T>): Promise<T> {
  // then(fn, fn)：前一个任务成功或失败都要放行下一个，否则一次异常会永久卡死队列
  const run = chain.then(fn, fn) as Promise<T>;
  chain = run.catch(() => undefined);
  return run;
}
