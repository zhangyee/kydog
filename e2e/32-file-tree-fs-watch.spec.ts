import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown } from './helpers';

// 复现「agent 写了一个 markdown，右侧文件树没刷新」：在主进程 watcher 视角下，
// 外部进程对 project root 的写入应触发 fs.changed，渲染端重 fetch 后 FileTree
// 出现新行。这里用 Playwright 直接写文件来模拟 agent 工具落盘。
test('32-file-tree-fs-watch: 外部新写入文件 → FileTree 自动出现新行', async () => {
  const launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      const projectPath = path.join(home, 'proj');
      await fs.mkdir(projectPath, { recursive: true });
      await fs.writeFile(path.join(projectPath, 'README.md'), '# initial\n');
      await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
    },
  });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');
    const seededPath = path.join(projectPath, 'README.md');
    const reportPath = path.join(projectPath, 'research-report.md');

    // 选中 thread → Inspector 渲染 FileTree
    await page.click('text=测试 Thread');
    await page.getByTestId(`fs-${seededPath}`).waitFor();

    // 新文件还没存在
    await expect(page.getByTestId(`fs-${reportPath}`)).toHaveCount(0);

    // 外部进程写入（模拟 agent Write 工具落盘）
    await fs.writeFile(reportPath, '# report\n');

    // chokidar awaitWriteFinish(200) + debounce(200) ≈ 400ms，给到 5s 留余量
    await expect(page.getByTestId(`fs-${reportPath}`)).toBeVisible({ timeout: 5000 });
  } finally {
    await teardown(launched);
  }
});

test('32-file-tree-fs-watch: 外部删除文件 → FileTree 行消失', async () => {
  const launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      const projectPath = path.join(home, 'proj');
      await fs.mkdir(projectPath, { recursive: true });
      await fs.writeFile(path.join(projectPath, 'README.md'), '# initial\n');
      await fs.writeFile(path.join(projectPath, 'tmp.md'), 'tmp\n');
      await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
    },
  });
  try {
    const { page, kydogHome } = launched;
    const projectPath = path.join(kydogHome, 'proj');
    const tmpPath = path.join(projectPath, 'tmp.md');

    await page.click('text=测试 Thread');
    await page.getByTestId(`fs-${tmpPath}`).waitFor();

    await fs.unlink(tmpPath);

    await expect(page.getByTestId(`fs-${tmpPath}`)).toHaveCount(0, { timeout: 5000 });
  } finally {
    await teardown(launched);
  }
});
