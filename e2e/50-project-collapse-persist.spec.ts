import { test, expect } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings } from './helpers';

async function seedTwoProjects(home: string, dirA: string, dirB: string) {
  await seedSettings(home);
  await fs.mkdir(path.join(home, '.kydog'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.kydog', 'index.json'),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: dirA, addedAt: '2026-01-01T00:00:00.000Z' },
        { path: dirB, addedAt: '2026-01-02T00:00:00.000Z' },
      ],
      threads: [
        { id: 't-a', projectPath: dirA, title: 'thread-A', createdAt: '2026-01-01', lastActiveAt: '2026-04-01' },
        { id: 't-b', projectPath: dirB, title: 'thread-B', createdAt: '2026-01-02', lastActiveAt: '2026-04-10' },
      ],
    }, null, 2),
  );
}

test('50-collapse-persist: 收起的 project 重启后仍是收起的，其余仍展开', async () => {
  const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-clpA-'));
  const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-clpB-'));
  const nameA = path.basename(dirA);
  let home = '';

  const l1 = await launchKydog({
    seed: async (h) => { home = h; await seedTwoProjects(h, dirA, dirB); },
  });
  try {
    // 起步两个 project 都是展开的
    await expect(l1.page.locator('[data-testid="thread-t-a"]')).toBeVisible();
    await expect(l1.page.locator('[data-testid="thread-t-b"]')).toBeVisible();

    await l1.page.getByTestId(`project-toggle-${nameA}`).click();
    await expect(l1.page.locator('[data-testid="thread-t-a"]')).toHaveCount(0);

    // 落盘的是路径本身，不是「第几个 project」这种会随排序漂移的东西
    await expect.poll(async () => {
      const raw = await fs.readFile(path.join(home, '.kydog', 'kydog.json'), 'utf8');
      return JSON.parse(raw).ui.collapsedProjects;
    }).toEqual([dirA]);
  } finally {
    await l1.app.close();
    await fs.rm(l1.userDataDir, { recursive: true, force: true }).catch(() => {});
  }

  const l2 = await launchKydog({ kydogHome: home });
  try {
    // A 仍收起（行还在，但它的 thread 不在），B 仍展开
    await expect(l2.page.getByTestId(`project-toggle-${nameA}`)).toBeVisible();
    await expect(l2.page.locator('[data-testid="thread-t-b"]')).toBeVisible();
    await expect(l2.page.locator('[data-testid="thread-t-a"]')).toHaveCount(0);

    // 再点开就能恢复
    await l2.page.getByTestId(`project-toggle-${nameA}`).click();
    await expect(l2.page.locator('[data-testid="thread-t-a"]')).toBeVisible();
  } finally {
    await teardown(l2);
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    await fs.rm(dirA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(dirB, { recursive: true, force: true }).catch(() => {});
  }
});
