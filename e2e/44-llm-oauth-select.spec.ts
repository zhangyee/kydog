import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, teardown, seedSettings } from './helpers';
import { selectPath } from './fixtures/oauth-mock';

test('44-llm: OAuth select 提示 → 选项可见可点，选完进入授权页', async () => {
  const tmpDir = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'kydog-oauth-select-'));
  const fixturePath = path.join(tmpDir, 'select.json');
  await fs.writeFile(fixturePath, JSON.stringify(selectPath));

  const launched = await launchKydog({
    seed: (home) => seedSettings(home, { providerConfigured: false }),
    env: { KYDOG_OAUTH_FIXTURE: fixturePath },
  });
  const { page } = launched;
  try {
    await page.getByRole('button', { name: '+ 添加 provider' }).click();
    await page.getByText('ChatGPT (Codex)', { exact: true }).click();
    await page.getByRole('button', { name: '登录' }).click();

    // select 早于 auth_url：此刻应该只有选项，没有授权链接那一块。
    // exact 必须加：状态行是「等待选择登录方式…」，非 exact 会同时命中它和区块标签，strict mode 直接报错。
    await expect(page.getByText('选择登录方式', { exact: true })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Select OpenAI Codex login method:')).toBeVisible();
    await expect(page.getByText('复制链接')).toHaveCount(0);

    const browserBtn = page.getByRole('button', { name: 'Browser login (default)' });
    await expect(browserBtn).toBeVisible();
    await expect(page.getByRole('button', { name: 'Device code login (headless)' })).toBeVisible();

    // 选完之后 fixture 才发 auth_url，授权链接那一块这时才出现。
    await browserBtn.click();
    await expect(page.getByText('复制链接')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('选择登录方式', { exact: true })).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});
