import { test, expect } from '@playwright/test';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject } from './helpers';

const LONG_NAME = '2026-前沿文献综述-多智能体协作在科研数据管线中的应用与后续待办梳理.md';
const SHORT_NAME = 'a.md';

test('49-file-marquee: 右栏文件树长文件名 hover 滚动，短名不滚', async () => {
  const launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      const projectPath = path.join(home, 'proj');
      await fs.mkdir(projectPath, { recursive: true });
      await fs.writeFile(path.join(projectPath, LONG_NAME), '# x\n');
      await fs.writeFile(path.join(projectPath, SHORT_NAME), '# y\n');
      await seedProject(home, projectPath, [{ id: 'thr-mq', title: '测试 Thread' }]);
    },
  });
  const { page, kydogHome } = launched;
  try {
    const longPath = path.join(kydogHome, 'proj', LONG_NAME);
    const shortPath = path.join(kydogHome, 'proj', SHORT_NAME);

    // 选中 thread，右栏才显示该项目的文件树
    await page.click('text=测试 Thread');
    const longRow = page.getByTestId(`fs-${longPath}`);
    await longRow.waitFor();

    const longScroll = page.getByTestId(`fs-name-scroll-${longPath}`);
    const shortScroll = page.getByTestId(`fs-name-scroll-${shortPath}`);

    // hover 是单发 mousemove、无到达回执（Playwright 的 hit-target 拦截器在事件
    // 未到达时照样返回 "done"）。把刺激放进 poll 每轮重新施加：断言仍是
    // 「hover 态下滚动节点存在且负向位移」，一个字没放宽；失败时返回页面态
    // JSON 落进 Received，红了直接携带协议层证据（hoverChain 指向派发/悬停链
    // 是否真的成立，reduce 指向媒体层是否有残留）。
    await expect.poll(async () => {
      await longRow.hover();
      if (await longScroll.count() === 0) {
        return await longRow.evaluate((el) => JSON.stringify({
          hoverChain: el.matches(':hover'),
          reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
        }));
      }
      return await longScroll.evaluate((el) => (el as HTMLElement).style.transform);
    }).toMatch(/translateX\(-\d/);

    // 移到短名行：长名复位（滚动节点消失），短名过了起始延迟也不滚
    await page.getByTestId(`fs-${shortPath}`).hover();
    await expect(longScroll).toHaveCount(0);
    await page.waitForTimeout(450);
    await expect(shortScroll).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});
