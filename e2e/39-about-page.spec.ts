import { test, expect } from '@playwright/test';
import { launchKydog, teardown } from './helpers';

test('39-about-page: 展示最新篇、往期可切换、版本行常驻', async () => {
  const launched = await launchKydog();
  const { page } = launched;
  try {
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-about"]').click();

    // 当前篇 = date 最大的 2026-08-03-hello
    await expect(page.locator('[data-testid="about-version"]')).toContainText('KyDog');
    await expect(page.locator('[data-testid="about-title"]')).toHaveText('关于 KyDog');
    await expect(page.locator('[data-testid="about-body"]')).toContainText('面向科研工作流');
    await expect(page.locator('[data-testid="about-back-to-latest"]')).toBeHidden();

    // 往期列表 = 除最新篇外的所有篇
    const items = page.locator('[data-testid="about-archive-item"]');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('2026-05-01');
    await expect(items.first()).not.toHaveAttribute('aria-current', 'true');

    // 切到往期篇：标题与正文变，版本行不变
    await items.first().click();
    await expect(page.locator('[data-testid="about-title"]')).toHaveText('KyDog MVP');
    await expect(page.locator('[data-testid="about-body"]')).toContainText('最初的 KyDog');
    await expect(page.locator('[data-testid="about-version"]')).toContainText('KyDog');
    await expect(items.first()).toHaveAttribute('aria-current', 'true');

    // 回到最新
    await page.locator('[data-testid="about-back-to-latest"]').click();
    await expect(page.locator('[data-testid="about-title"]')).toHaveText('关于 KyDog');
    await expect(page.locator('[data-testid="about-back-to-latest"]')).toBeHidden();
    await expect(items.first()).not.toHaveAttribute('aria-current', 'true');

    // 授权块仍在
    await expect(page.locator('[data-testid="about-ofl-text"]')).toContainText('SIL OPEN FONT LICENSE');
  } finally {
    await teardown(launched);
  }
});
