import { rmSync } from 'node:fs';

/**
 * `vitest.config.ts` 为测试进程建的临时主目录（HOME / USERPROFILE 指向它），全部跑完之后删掉。
 * 路径经 `KYDOG_VITEST_HOME` 传过来：配置文件与 globalSetup 跑在同一个 vitest 主进程里。
 */
export default function setup(): () => void {
  return () => {
    const dir = process.env.KYDOG_VITEST_HOME;
    if (dir) rmSync(dir, { recursive: true, force: true });
  };
}
