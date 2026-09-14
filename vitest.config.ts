import { defineConfig } from 'vitest/config';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// **测试进程的主目录指到一个临时目录。** `src/main/log.ts` 在模块加载时就用 `os.homedir()`
// 算好日志路径，测试里 `vi.spyOn(paths, 'ROOT', 'get')` 管不到它 —— 不重定向的话，每跑一次
// `npm test` 就往开发者真实的 `~/.kydog/logs/main.log` 里写上千条夹具产生的假 error（排查
// 真实故障时会被它误导），日志又只留一代备份，写满一次就把上一份真实备份覆盖掉（2026-09-14 实测）。
// `os.homedir()` 在 POSIX 上读 HOME、在 Windows 上读 USERPROFILE，两个都要设。一并挡住的还有
// 其他直接拿 `os.homedir()` 拼 `~/.kydog` 的地方（`skillResourceLoader.ts` 的 KYDOG_SKILLS_DIR）。
// 守这件事的是 `src/main/log.realHome.test.ts`；跑完由 globalSetup 的收尾删掉这个目录。
const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'kydog-vitest-home-'));
process.env.KYDOG_VITEST_HOME = TEST_HOME;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
    exclude: ['e2e/**', 'node_modules/**'],
    globals: false,
    passWithNoTests: true,
    // pi 的 ModelRuntime.create() 在有凭据时会真去拉模型目录（model-runtime.js:71,74）；
    // PI_OFFLINE 是它自己的断网开关，单测一律走静态目录，不做网络 I/O。
    env: { PI_OFFLINE: '1', HOME: TEST_HOME, USERPROFILE: TEST_HOME },
    globalSetup: ['./src/test-support/vitestHome.globalSetup.ts'],
    // 墙上时间是 infra 预算，慢 runner（CI 里观测到 macos-15-intel 这类机型，同一轮
    // 其余用例都在 5.3-5.8s，卡的是墙钟不是行为）可以宽；行为断言不受影响。
    // 本地保持 vitest 默认的 5000ms，让慢测试尽早暴露——所以这里不写具体数字，
    // 写 undefined 表示「不覆盖」，而不是把本地也顺手放宽。
    testTimeout: process.env.CI ? 15_000 : undefined,
  },
});
