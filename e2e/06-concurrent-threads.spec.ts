import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

test('06-concurrent: two threads streaming with same fixture do not cross-contaminate', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const fixture = path.resolve('e2e/fixtures/happy-path-text.json');

  const launched = await launchKydog({
    fixture,
    seed: async (home) => {
      await seedSettings(home);
      await seedProject(home, projectPath, [
        { id: '00000000-0000-0000-0000-00000000000a', title: 'Thread A' },
        { id: '00000000-0000-0000-0000-00000000000b', title: 'Thread B' },
      ]);
    },
  });
  try {
    // 打开 A，发送
    await launched.page.locator('[data-testid="thread-00000000-0000-0000-0000-00000000000a"]').click();
    await launched.page.locator('[data-testid="composer-input"]').fill('hello A');
    await launched.page.locator('[data-testid="send-button"]').click();
    // 立刻切到 B，发送
    await launched.page.locator('[data-testid="thread-00000000-0000-0000-0000-00000000000b"]').click();
    await launched.page.locator('[data-testid="composer-input"]').fill('hello B');
    await launched.page.locator('[data-testid="send-button"]').click();
    // 等 B 跑完
    await expect(launched.page.locator('[data-testid="message-list"]')).toContainText('hello B');
    await expect(launched.page.locator('[data-testid="message-list"]')).toContainText('我是 KyDog', { timeout: 6000 });
    // 切回 A，应只看到 A 的内容
    await launched.page.locator('[data-testid="thread-00000000-0000-0000-0000-00000000000a"]').click();
    await expect(launched.page.locator('[data-testid="message-list"]')).toContainText('hello A');
    await expect(launched.page.locator('[data-testid="message-list"]')).not.toContainText('hello B');
  } finally {
    await teardown(launched);
  }
});
