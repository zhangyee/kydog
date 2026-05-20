import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchKydog, seedSettings, seedProject, teardown } from './helpers';

test('33-write-file-card: write 工具落盘 .md → 文件卡出现 → 单击打开 markdown tab', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-fixt-'));
  const fixtureTemplate = await fs.readFile(path.resolve('e2e/fixtures/write-markdown.json'), 'utf8');
  let launched: Awaited<ReturnType<typeof launchKydog>> | null = null;
  let reportPath = '';
  try {
    const concreteFixturePath = path.join(tmpDir, 'write-markdown.json');
    launched = await launchKydog({
      fixture: concreteFixturePath,
      seed: async (home) => {
        await seedSettings(home);
        const projectPath = path.join(home, 'proj');
        await fs.mkdir(projectPath, { recursive: true });
        reportPath = path.join(projectPath, 'report.md');
        // 真落盘：fixture 不会实际写盘，markdown tab 打开时要能读到内容
        await fs.writeFile(reportPath, '# report\n\n正文\n');
        await seedProject(home, projectPath, [{ id: 'thr-1', title: 'WriteTest' }]);
        const concrete = fixtureTemplate.replace('__REPORT_PATH__', reportPath);
        await fs.writeFile(concreteFixturePath, concrete);
      },
    });
    const { page } = launched;

    // 选中 seeded thread，触发会话
    await page.click('text=WriteTest');
    await page.locator('[data-testid="composer-input"]').fill('生成报告');
    await page.locator('[data-testid="send-button"]').click();

    // 文件卡出现在消息末尾
    const card = page.locator(`[data-testid="file-card-${reportPath}"]`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    // 单击 → markdown tab 打开
    await card.click();
    await expect(page.locator(`[data-testid="tab-${reportPath}"]`)).toBeVisible();
    const editor = page.locator('.kydog-md-editor .ProseMirror');
    await expect(editor).toContainText('report');
  } finally {
    if (launched) await teardown(launched);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
