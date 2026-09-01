import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
    exclude: ['e2e/**', 'node_modules/**'],
    globals: false,
    passWithNoTests: true,
    // pi 的 ModelRuntime.create() 在有凭据时会真去拉模型目录（model-runtime.js:71,74）；
    // PI_OFFLINE 是它自己的断网开关，单测一律走静态目录，不做网络 I/O。
    env: { PI_OFFLINE: '1' },
    // 墙上时间是 infra 预算，慢 runner（CI 里观测到 macos-15-intel 这类机型，同一轮
    // 其余用例都在 5.3-5.8s，卡的是墙钟不是行为）可以宽；行为断言不受影响。
    // 本地保持 vitest 默认的 5000ms，让慢测试尽早暴露——所以这里不写具体数字，
    // 写 undefined 表示「不覆盖」，而不是把本地也顺手放宽。
    testTimeout: process.env.CI ? 15_000 : undefined,
  },
});
