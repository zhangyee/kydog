import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings, seedSamplePackage } from './helpers';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function seedTwoProjects(home: string, projDirA: string, projDirB: string) {
  await seedSettings(home);
  await seedSamplePackage(projDirA);
  await seedSamplePackage(projDirB);
  await fs.writeFile(
    path.join(home, '.kydog', 'index.json'),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: projDirA, addedAt: '2026-01-01T00:00:00Z' },
        { path: projDirB, addedAt: '2026-01-02T00:00:00Z' },
      ],
      threads: [
        { id: 't-a', projectPath: projDirA, title: 'thread-A', createdAt: '2026-01-01', lastActiveAt: '2026-04-01' },
        { id: 't-b', projectPath: projDirB, title: 'thread-B', createdAt: '2026-01-02', lastActiveAt: '2026-04-10' },
      ],
    }, null, 2),
  );
}

test('18-projects-sidebar: collapse-all + filter sort', async () => {
  const projDirA = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-A-'));
  const projDirB = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-B-'));
  const launched = await launchKydog({
    seed: async (h) => seedTwoProjects(h, projDirA, projDirB),
  });
  const { page } = launched;
  try {
    const nameA = path.basename(projDirA);

    await expect(page.locator('[data-testid="thread-t-a"]')).toBeVisible();
    await expect(page.locator('[data-testid="thread-t-b"]')).toBeVisible();

    await page.locator('[data-testid="projects-collapse-all"]').click();
    await expect(page.locator('[data-testid="thread-t-a"]')).toBeHidden();
    await expect(page.locator('[data-testid="thread-t-b"]')).toBeHidden();

    await page.locator(`[data-testid="project-toggle-${nameA}"]`).click();
    await expect(page.locator('[data-testid="thread-t-a"]')).toBeVisible();

    await page.locator('[data-testid="projects-filter-trigger"]').click();
    await expect(page.locator('[data-testid="projects-filter-menu"]')).toBeVisible();
    await page.locator('[data-testid="filter-sort-created"]').click();
    await expect(page.locator('[data-testid="projects-filter-menu"]')).toBeHidden();
  } finally {
    await teardown(launched);
    await fs.rm(projDirA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(projDirB, { recursive: true, force: true }).catch(() => {});
  }
});

test('18-projects-sidebar: pin project persists across restart', async () => {
  const projDirA = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-pinA-'));
  const projDirB = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-pinB-'));
  let savedHome = '';

  const l1 = await launchKydog({
    seed: async (h) => { savedHome = h; await seedTwoProjects(h, projDirA, projDirB); },
  });
  try {
    const nameB = path.basename(projDirB);
    // hover 目标必须是 ProjectRow 自己的 .group 行（project-toggle-*），不能是
    // ProjectsTree 里包住整行 + 子节点区域的外层 wrapper（project-${path}）——
    // .hover() 落在 wrapper 外接矩形的中心点，行高差一点（字体渲染/DPI）就可能
    // 跨出真正持有 onMouseEnter 的那个 .group div，导致操作按钮一直不出现。
    await l1.page.locator(`[data-testid="project-toggle-${nameB}"]`).hover();
    await l1.page.locator(`[data-testid="project-menu-trigger-${nameB}"]`).click();
    await l1.page.locator(`[data-testid="project-pin-${nameB}"]`).click();

    // 这个 poll 等的是**落盘**（RPC → loadIndex → 原子写），不是 UI 响应速度，所以给足余量：
    // 满负载连跑多个 spec 时它超过默认的 5s，观察到过一次假红。放宽的是基础设施等待，
    // 不是行为判据 —— 「点没点到」已经由上一行 click 的 actionability 保证了（真没点到会
    // 停在那一行，而不是走到这里）。
    await expect.poll(async () => {
      const idxRaw = await fs.readFile(path.join(savedHome, '.kydog', 'index.json'), 'utf8');
      return JSON.parse(idxRaw).projects.find((p: { path: string; pinned?: boolean }) => p.path === projDirB)?.pinned === true;
    }, { timeout: 15_000 }).toBe(true);
  } finally {
    await l1.app.close();
    await fs.rm(l1.userDataDir, { recursive: true, force: true }).catch(() => {});
  }

  const l2 = await launchKydog({
    seed: async (h) => {
      await fs.mkdir(path.join(h, '.kydog'), { recursive: true });
      const idx = await fs.readFile(path.join(savedHome, '.kydog', 'index.json'), 'utf8');
      await fs.writeFile(path.join(h, '.kydog', 'index.json'), idx);
      const settings = await fs.readFile(path.join(savedHome, '.kydog', 'kydog.json'), 'utf8');
      await fs.writeFile(path.join(h, '.kydog', 'kydog.json'), settings);
    },
  });
  try {
    const nameA = path.basename(projDirA);
    const nameB = path.basename(projDirB);
    await expect(l2.page.locator(`[data-testid="project-toggle-${nameB}"]`)).toBeVisible();
    const togglePaths = await l2.page.locator('[data-testid^="project-toggle-"]').evaluateAll(els => els.map(el => el.getAttribute('data-testid')));
    expect(togglePaths[0]).toBe(`project-toggle-${nameB}`);
    expect(togglePaths[1]).toBe(`project-toggle-${nameA}`);
  } finally {
    await teardown(l2);
    await fs.rm(savedHome, { recursive: true, force: true }).catch(() => {});
    await fs.rm(projDirA, { recursive: true, force: true }).catch(() => {});
    await fs.rm(projDirB, { recursive: true, force: true }).catch(() => {});
  }
});

test('18-projects-sidebar: inline rename project', async () => {
  const projDirA = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-rn-'));
  let savedHome = '';
  const l1 = await launchKydog({
    seed: async (h) => {
      savedHome = h;
      await seedSettings(h);
      await seedSamplePackage(projDirA);
      await fs.writeFile(
        path.join(h, '.kydog', 'index.json'),
        JSON.stringify({
          schemaVersion: 1,
          projects: [{ path: projDirA, addedAt: '2026-01-01T00:00:00Z' }],
          threads: [],
        }, null, 2),
      );
    },
  });
  try {
    const oldName = path.basename(projDirA);
    const newName = '我的研究';
    // hover 目标必须是 ProjectRow 自己的 .group 行（project-toggle-*），不能是
    // ProjectsTree 里包住整行 + 子节点区域的外层 wrapper（project-${path}）——
    // .hover() 落在 wrapper 外接矩形的中心点，行高差一点（字体渲染/DPI）就可能
    // 跨出真正持有 onMouseEnter 的那个 .group div，导致操作按钮一直不出现。
    await l1.page.locator(`[data-testid="project-toggle-${oldName}"]`).hover();
    await l1.page.locator(`[data-testid="project-menu-trigger-${oldName}"]`).click();
    await l1.page.locator(`[data-testid="project-rename-${oldName}"]`).click();
    const input = l1.page.locator(`[data-testid="project-rename-input-${oldName}"]`);
    await expect(input).toBeFocused();
    await input.fill(newName);
    await input.press('Enter');
    await expect(l1.page.locator(`[data-testid="project-toggle-${newName}"]`)).toBeVisible();
    await expect.poll(async () => {
      const idxRaw = await fs.readFile(path.join(savedHome, '.kydog', 'index.json'), 'utf8');
      return JSON.parse(idxRaw).projects.find((p: { path: string; label?: string }) => p.path === projDirA)?.label;
    }).toBe(newName);
  } finally {
    await teardown(l1);
    await fs.rm(savedHome, { recursive: true, force: true }).catch(() => {});
    await fs.rm(projDirA, { recursive: true, force: true }).catch(() => {});
  }
});
