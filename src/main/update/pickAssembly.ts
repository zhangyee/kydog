export type Assembly = 'fixture' | 'real' | 'noop';

/** 装配判定。刻意与 assemble.ts 分家：那边 import electron，node 环境的单测加载不了。
 *
 *  两个顺序都是有意的：
 *  - fixture 分支必须同时要求 e2e —— 否则一个残留的环境变量就能让正式版装上测试服务。
 *  - 未打包（npm start）与 e2e 一律 no-op —— macOS 走的是裸 fetch，没有这道闸
 *    开发态与打包后的 e2e 都会在启动 30 秒后打到 update.electronjs.org。
 *    闸只此一处，因此定时检查与手动检查同受其管。
 */
export function pickAssembly(env: { isPackaged: boolean; e2e?: string; fixture?: string }): Assembly {
  if (env.e2e === '1' && env.fixture) return 'fixture';
  if (env.isPackaged && env.e2e !== '1') return 'real';
  return 'noop';
}
