import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings } from './helpers';

test('00-shell: app boots; three panes render; theme applies; settings pane force-opens on first run', async () => {
  // onboarding 已完成、但未配置 provider 的"首次真实使用"态：settings 面板强制打开。
  const launched = await launchKydog({ seed: (home) => seedSettings(home, { providerConfigured: false }) });
  const { page } = launched;
  try {
    await expect(page.locator('[data-pane="workspace"]')).toBeVisible();
    await expect(page.locator('[data-pane="main"]')).toBeVisible();
    await expect(page.locator('[data-pane="inspector"]')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'vellum');
    // First run (no kydog.json): bootstrap auto-opens the settings tab on the
    // provider page so the user can configure a provider before doing anything.
    await expect(page.locator('[data-testid="tab-__settings__"]')).toBeVisible();
    await expect(page.getByText('还未配置任何 provider')).toBeVisible();

    // e2e 跑的是未打包的 main.js，dev 模式会在 loadFile 之后开一个分离的 DevTools 窗口。
    // 它在 macOS 上会成为 key window，主窗口随即 blur，渲染层 document.hasFocus() 变 false；
    // 这个 blur 落在哪一相位由启动速度决定，撞进「最后一次点击 → toBeFocused 首轮」之间就是
    // 34-thread-rename / 18-projects-sidebar 那种间歇红（main.ts 里 openDevTools 处有全文）。
    // 这里守的是源头：整个应用里只有主窗口这一份 webContents，没有 DevTools 的那份。
    // 检查点放在 load 之后——openDevTools 恰好挂在 did-finish-load 上，DevTools 的
    // webContents 是在那一刻同步建出来的，所以 load 一过它要么已经在列表里、要么永远不会有。
    await page.waitForLoadState('load');
    const webContentsTypes = await launched.app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((wc) => wc.getType()),
    );
    expect(webContentsTypes).toEqual(['window']);
  } finally {
    await teardown(launched);
  }
});
