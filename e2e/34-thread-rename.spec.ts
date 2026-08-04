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

// 回归：窗口整体失焦时，浏览器也会在重命名输入框上派发 blur，但它仍是
// document.activeElement。曾经把这当成「编辑结束」去提交，导致用户切到别的
// 应用再切回来编辑框就没了；在负载较高的机器上，启动期的一次瞬时失焦还会让
// 上面那个用例间歇性失败（输入框在 Enter 落下前被卸载）。
test('34-thread-rename: 切走再切回来，重命名框和已输入内容都还在', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-blur-'));
  await seedSamplePackage(projectPath);
  const launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      await seedProject(home, projectPath, [{ id: THREAD_ID, title: '旧名字' }]);
    },
  });
  try {
    const { page } = launched;
    const row = page.locator(`[data-testid="thread-${THREAD_ID}"]`);
    await expect(row).toBeVisible();
    await row.hover();
    await page.locator(`[data-testid="thread-menu-trigger-${THREAD_ID}"]`).click();
    await page.locator(`[data-testid="thread-rename-${THREAD_ID}"]`).click();

    const input = page.locator(`[data-testid="thread-rename-input-${THREAD_ID}"]`);
    await expect(input).toBeFocused();
    await input.fill('改到一半');

    // 这里把 document.hasFocus 打桩成 false 再触发真实 blur。
    // 打桩的只是「窗口已失焦」这个前置条件 —— 它无法在 e2e 里按需制造：
    // BrowserWindow.blur() 和「另开窗口抢焦点」都试过，hasFocus 都不变。
    // 而这个状态真实存在：在 14 路 CPU 负载下复现原缺陷时，onBlur 里实测到
    // related=null、activeElement 仍是本输入框、hasFocus=false。
    // blur 事件本身没有伪造，走的是完整的 React 合成事件路径。
    await page.evaluate((id) => {
      document.hasFocus = () => false;
      document.querySelector<HTMLElement>(`[data-testid="thread-rename-input-${id}"]`)?.blur();
    }, THREAD_ID);

    // 修复前这里输入框已经被卸载了
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('改到一半');

    // 反向：恢复后，焦点移到应用内别处仍然应当提交（别把正常行为一起改坏）
    await page.evaluate(() => { delete (document as Partial<Document>).hasFocus; });
    await input.fill('新名字');
    await input.press('Tab');
    await expect(input).toBeHidden();
    await expect(row).toContainText('新名字');
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
