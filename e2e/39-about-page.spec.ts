import { test, expect } from '@playwright/test';
import { launchKydog, teardown } from './helpers';

test('39-about-page: 展示最新篇、往期可切换、版本行常驻', async () => {
  const launched = await launchKydog();
  const { page } = launched;
  try {
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-about"]').click();

    // 版本行搬到了设置页头部（settings-version），关于页正文里不再重复一份
    await expect(page.locator('[data-testid="settings-version"]')).toContainText('v');
    // 存下切换前的版本行原文，切到往期后按逐字相等比对，防止「只要含 v 就算过」的假阳性
    const versionText = await page.locator('[data-testid="settings-version"]').textContent();
    if (versionText === null) throw new Error('settings-version textContent 不应为 null');
    // 当前篇 = date 最大的 2026-08-03-read-me
    await expect(page.locator('[data-testid="about-title"]')).toHaveText('关于KyDog');
    await expect(page.locator('[data-testid="about-body"]')).toContainText('fastpaper-cli');
    await expect(page.locator('[data-testid="about-back-to-latest"]')).toBeHidden();

    // 往期列表 = 除最新篇外的所有篇；以下内容断言绑定 src/about 当前的两篇正文，新增/删改文章时要同步更新
    const items = page.locator('[data-testid="about-archive-item"]');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('2026-05-27');
    await expect(items.first()).not.toHaveAttribute('aria-current', 'true');

    // 切到往期篇：标题与正文变，版本行逐字不变
    await items.first().click();
    await expect(page.locator('[data-testid="about-title"]')).toHaveText('关于 KyDog');
    await expect(page.locator('[data-testid="about-body"]')).toContainText('面向科研工作流');
    await expect(page.locator('[data-testid="settings-version"]')).toHaveText(versionText);
    await expect(items.first()).toHaveAttribute('aria-current', 'true');

    // 回到最新
    await page.locator('[data-testid="about-back-to-latest"]').click();
    await expect(page.locator('[data-testid="about-title"]')).toHaveText('关于KyDog');
    await expect(page.locator('[data-testid="about-back-to-latest"]')).toBeHidden();
    await expect(items.first()).not.toHaveAttribute('aria-current', 'true');

    // 开源许可：整页替换成许可内容（字体 OFL 全文 + 依赖库列表），返回后落回当前篇
    await page.locator('[data-testid="about-licenses-entry"]').click();
    await expect(page.locator('[data-testid="about-title"]')).toBeHidden();
    const licensesBack = page.locator('[data-testid="about-licenses-back"]');
    await expect(licensesBack).toBeVisible();
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).toContain('SIL OPEN FONT LICENSE');
    expect(bodyText).toContain('react'); // 开源库列表里的一条依赖

    await licensesBack.click();
    await expect(page.locator('[data-testid="about-title"]')).toHaveText('关于KyDog');
    await expect(licensesBack).toBeHidden();
  } finally {
    await teardown(launched);
  }
});
