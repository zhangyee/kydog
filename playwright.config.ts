import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // 两个预算分开，别混成一个：
  //
  // timeout 是「整条用例的墙上时间」，必须覆盖 Electron 冷启动（helpers.ts 里
  // 光 launch 就允许 20s）+ 应用关闭。这部分是纯基础设施开销，耗时随机器负载
  // 浮动，不携带任何行为信息 —— 给它 30s 等于隐含假设「跑测试时机器不忙」。
  //
  // 为什么从 30s 提到 60s：12-user-menu 在机器繁忙时间歇超时，三次独立观察到，
  // 复现过一次（load average ~100），报的是**裸的 test timeout，没有任何断言
  // 错误**，同时伴随 Worker teardown timeout。断言判错时 Playwright 会明确报
  // expect(...).toBeVisible() failed；报裸超时说明到点时还卡在做事，而这条 spec
  // 全是自动重试断言、没有一个裸等待 —— 最可能是还堵在 launchKydog 里，teardown
  // 也超时则独立印证了是整个 Electron 生命周期慢，不是某个断言。
  // （注：受控红绿没做成 —— 事后无法稳定合成出当时那种负载。）
  //
  // expect.timeout 才是「UI 该在多久内响应」这个行为判据，必须保持紧 —— 应用
  // 真坏了要快速失败，不能靠放大它来掩盖。显式写出来是为了讲清这条不能动：
  // 放大上面那个是给基础设施留余量，放大这个是掩盖 bug，两者不是一回事。
  timeout: 60_000,
  expect: { timeout: 5_000 },
  // CI-only retry：整条用例在更安静的第二次机会里重跑，expect.timeout 保持上面那条紧判据，
  // 不是放大任何断言的容忍度。重试后转绿的用例 Playwright 标 flaky 列进摘要（不静默），
  // 失败尝试的 trace 留在 test-results（2026-09-01 受控实验证实），由 workflow 的
  // if: always() 上传步骤带出 CI。本地恒为 0：开发时该红照红。
  retries: process.env.CI ? 1 : 0,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
});
