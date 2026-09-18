import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings, type LaunchedApp } from './helpers';

/**
 * 用户菜单与界面偏好：菜单各项、主题、阅读字号、两栏收起。串行共用一次启动：
 * 第一条要断「启动时设置页没开」，收栏那条改布局，放最后。
 */
test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
test.beforeAll(async () => { launched = await launchKydog({ seed: seedSettings }); });
test.afterAll(async () => { await teardown(launched); });

test('12-user-menu: opens with all sections; account CTA opens settings pane', async () => {
  const { page } = launched;
  // 配好了 provider：启动时设置页不自动打开（正向证明在下面点了账号入口之后）。
  await expect(page.locator('[data-testid="tab-__settings__"]')).toBeHidden();

  await page.locator('[data-testid="user-menu-trigger"]').click();
  await expect(page.locator('[data-testid="user-menu"]')).toBeVisible();
  for (const id of ['locale-zh', 'locale-en', 'theme-vellum', 'theme-lilac', 'menu-donate', 'menu-about', 'open-research']) {
    await expect(page.getByTestId(id)).toBeVisible();
  }

  // 账号入口：openSettings('provider') 并收起菜单；seedSettings 配的 Anthropic 在列表里。
  await page.locator('[data-testid="open-settings"]').click();
  await expect(page.locator('[data-testid="user-menu"]')).toBeHidden();
  await expect(page.locator('[data-testid="tab-__settings__"]')).toBeVisible();
  await expect(page.getByText('Anthropic').first()).toBeVisible();
});

test('11-themes: five themes switch via UserMenu and toggle data-theme', async () => {
  const { page } = launched;
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'vellum');
  await page.locator('[data-testid="user-menu-trigger"]').click();
  for (const name of ['porcelain', 'sepia', 'midnight', 'lilac', 'vellum'] as const) {
    await page.getByTestId(`theme-${name}`).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', name);
  }
});

test('36-font-size: 三档切换写入 <html data-reading-size>，--reading-font-size 跟着级联', async () => {
  const { page } = launched;
  // 直接读 :root 上的 CSS 变量，确认规则真的级联到了；正文各处都用 var(--reading-font-size)。
  const readVar = () => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--reading-font-size').trim());
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-reading-size', 'medium');
  expect(await readVar()).toBe('15px');

  await expect(page.locator('[data-testid="user-menu"]')).toBeVisible();
  for (const [size, px] of [['large', '17px'], ['small', '13.5px'], ['medium', '15px']] as const) {
    await page.getByTestId(`reading-size-${size}`).click();
    await expect(html).toHaveAttribute('data-reading-size', size);
    expect(await readVar()).toBe(px);
  }
});

test('09-collapse: workspace and inspector each toggle independently', async () => {
  const { page } = launched;
  // 菜单是浮层，先收起来再点两栏的按钮。
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="user-menu"]')).toBeHidden();

  const ws = page.locator('[data-pane="workspace"]');
  const ins = page.locator('[data-pane="inspector"]');
  const width = (l: typeof ws) => l.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
  expect(await width(ws)).toBeGreaterThan(100);
  expect(await width(ins)).toBeGreaterThan(100);

  await page.locator('[data-testid="collapse-workspace"]').click();
  await expect.poll(() => width(ws)).toBeLessThan(40);
  // 各管各的：收左栏不牵动右栏。
  expect(await width(ins)).toBeGreaterThan(100);

  await page.locator('[data-testid="collapse-inspector"]').click();
  await expect.poll(() => width(ins)).toBeLessThan(40);
});
