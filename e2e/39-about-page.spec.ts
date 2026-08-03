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
    // 存下切换前的版本行原文，切到往期后按逐字相等比对，防止「只要含 KyDog 就算过」的假阳性
    const versionText = await page.locator('[data-testid="about-version"]').textContent();
    if (versionText === null) throw new Error('about-version textContent 不应为 null');
    await expect(page.locator('[data-testid="about-title"]')).toHaveText('关于 KyDog');
    await expect(page.locator('[data-testid="about-body"]')).toContainText('面向科研工作流');
    await expect(page.locator('[data-testid="about-back-to-latest"]')).toBeHidden();

    // 往期列表 = 除最新篇外的所有篇；以下内容断言绑定 src/about 当前的两篇正文，新增/删改文章时要同步更新
    const items = page.locator('[data-testid="about-archive-item"]');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('2026-05-01');
    await expect(items.first()).not.toHaveAttribute('aria-current', 'true');

    // 切到往期篇：标题与正文变，版本行逐字不变
    await items.first().click();
    await expect(page.locator('[data-testid="about-title"]')).toHaveText('KyDog MVP');
    await expect(page.locator('[data-testid="about-body"]')).toContainText('最初的 KyDog');
    await expect(page.locator('[data-testid="about-version"]')).toHaveText(versionText);
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
