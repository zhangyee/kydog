import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, teardown, seedSettings } from './helpers';
import { cancelPath } from './fixtures/oauth-mock';

test('26-llm: OAuth login (fixture cancelPath) → cancel returns to idle', async () => {
  const tmpDir = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'kydog-oauth-'));
  const fixturePath = path.join(tmpDir, 'cancel.json');
  await fs.writeFile(fixturePath, JSON.stringify(cancelPath));

  const launched = await launchKydog({
    seed: (home) => seedSettings(home, { providerConfigured: false }),
    env: { KYDOG_OAUTH_FIXTURE: fixturePath },
  });
  const { page } = launched;
  try {
    await page.getByRole('button', { name: '+ 添加 provider' }).click();
    // ChatGPT (Codex) is a pure OAuth provider (kind=oauth).
    await page.getByText('ChatGPT (Codex)', { exact: true }).click();
    await page.getByRole('button', { name: '登录' }).click();

    // Fixture's onAuthAfterMs=50, so the URL block + 复制链接 button appears quickly.
    await expect(page.getByText('复制链接')).toBeVisible({ timeout: 5000 });

    // Cancel returns to idle (login button reappears).
    await page.getByRole('button', { name: '取消' }).click();
    await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
  } finally {
    await teardown(launched);
  }
});
