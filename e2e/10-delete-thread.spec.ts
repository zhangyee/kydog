import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

test('10-delete: removes thread from index and JSONL on disk', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      await seedProject(home, projectPath, [{ id: 'cccccccc-1111-1111-1111-111111111111', title: 'doomed' }]);
    },
  });
  try {
    const row = launched.page.locator('[data-testid="thread-cccccccc-1111-1111-1111-111111111111"]');
    await expect(row).toBeVisible();
    await row.hover();
    await launched.page.locator('[data-testid="delete-thread-cccccccc-1111-1111-1111-111111111111"]').click();
    await expect(launched.page.locator('[data-testid="confirm-dialog"]')).toBeVisible();
    await launched.page.locator('[data-testid="confirm-dialog-confirm"]').click();
    await expect(row).toBeHidden();
    // 校验 disk 上 index 已更新
    const indexRaw = await fs.readFile(path.join(launched.kydogHome, '.kydog', 'index.json'), 'utf8');
    expect(JSON.parse(indexRaw).threads).toEqual([]);
  } finally {
    await teardown(launched);
  }
});
