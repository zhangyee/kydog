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

    const card = page.getByTestId(`file-card-${reportPath}`);

    // ① 本轮还没结束时**不出卡片**。
    // agent 落盘的那一刻正文可能还在一章章往里填（learning-deck 的模板是 `cp` 之后
    // 逐章 `edit` 渲染的），交付前自检也还没跑，这时点开是半成品。
    //
    // 这一组不是「顺手多测一句」：fixture 里 tool_end 与 agent_end 之间刻意留了
    // 1500ms，先等 write 的工具卡真的落地（证明 write 块已经在消息里了），
    // 再断言卡片仍然不在。缺了这一步，toBeHidden 会在 tool_end 到达之前就平凡通过。
    await expect(page.locator('[data-testid="tool-tc1"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="streaming-indicator"]')).toBeVisible();
    await expect(card).toBeHidden();

    // ② 本轮结束（agent_end → run.message_end，消息落进 history）之后才出现。
    await expect(page.locator('[data-testid="streaming-indicator"]')).toBeHidden({ timeout: 10_000 });
    await expect(card).toBeVisible({ timeout: 10_000 });

    // 单击 → markdown tab 打开
    await card.click();
    await expect(page.getByTestId(`tab-${reportPath}`)).toBeVisible();
    const editor = page.locator('.kydog-md-editor .ProseMirror');
    await expect(editor).toContainText('report');
  } finally {
    if (launched) await teardown(launched);
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
