import { test, expect } from '@playwright/test';
import { launchKydog, teardown } from './helpers';

test('40-sponsor: 支持作者页展示赞赏码，且图片真的加载出来了', async () => {
  const launched = await launchKydog();
  const { page } = launched;
  try {
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-donate"]').click();

    const qr = page.locator('[data-testid="sponsor-qr"]');
    await expect(qr).toBeVisible();

    // 只断言可见没有意义：打包后资源路径解析不到时，<img> 元素照样可见、只是裂图。
    // naturalWidth 非 0 才证明 vite 产出的 ./assets/sponsor-<hash>.jpg 在 file:// 下真被解码了。
    await expect.poll(() => qr.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  } finally {
    await teardown(launched);
  }
});
