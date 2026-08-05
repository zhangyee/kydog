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
  },
});
