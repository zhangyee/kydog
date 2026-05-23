import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

const THREAD_ID = 'dddddddd-2222-2222-2222-222222222222';

test('34-thread-rename: 菜单重命名写回 index', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-rn-'));
  await seedSamplePackage(projectPath);
  const launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      await seedProject(home, projectPath, [{ id: THREAD_ID, title: '旧名字' }]);
    },
  });
  try {
    const row = launched.page.locator(`[data-testid="thread-${THREAD_ID}"]`);
    await expect(row).toBeVisible();
    await row.hover();
    await launched.page.locator(`[data-testid="thread-menu-trigger-${THREAD_ID}"]`).click();
    await launched.page.locator(`[data-testid="thread-rename-${THREAD_ID}"]`).click();
    const input = launched.page.locator(`[data-testid="thread-rename-input-${THREAD_ID}"]`);
    await expect(input).toBeFocused();
    await input.fill('新名字');
    await input.press('Enter');
    await expect(row).toContainText('新名字');
    await expect.poll(async () => {
      const idxRaw = await fs.readFile(path.join(launched.kydogHome, '.kydog', 'index.json'), 'utf8');
      return JSON.parse(idxRaw).threads.find((t: { id: string; title?: string }) => t.id === THREAD_ID)?.title;
    }).toBe('新名字');
  } finally {
    await teardown(launched);
    await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
  }
});

test('34-thread-rename: 删除点取消则会话保留', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-cancel-'));
  await seedSamplePackage(projectPath);
  const launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      await seedProject(home, projectPath, [{ id: THREAD_ID, title: '保留我' }]);
    },
  });
  try {
    const row = launched.page.locator(`[data-testid="thread-${THREAD_ID}"]`);
    await expect(row).toBeVisible();
    await row.hover();
    await launched.page.locator(`[data-testid="delete-thread-${THREAD_ID}"]`).click();
    await expect(launched.page.locator('[data-testid="confirm-dialog"]')).toBeVisible();
    await launched.page.locator('[data-testid="confirm-dialog-cancel"]').click();
    await expect(launched.page.locator('[data-testid="confirm-dialog"]')).toBeHidden();
    await expect(row).toBeVisible();
    const idxRaw = await fs.readFile(path.join(launched.kydogHome, '.kydog', 'index.json'), 'utf8');
    expect(JSON.parse(idxRaw).threads).toHaveLength(1);
  } finally {
    await teardown(launched);
    await fs.rm(projectPath, { recursive: true, force: true }).catch(() => {});
  }
});
