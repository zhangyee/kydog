import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchKydog, teardown, seedSettings, seedProject } from './helpers';

test('37a-onboarding: 首启向导 → 自定义称呼走完 → 三文件落盘 → 二次启动跳过', async () => {
  // provider 已配置但 onboarding 未完成：模型必填与默认值走完可同时成立（spec §11）。
  const launched = await launchKydog({
    freshHome: true,
    seed: async (home) => { await seedSettings(home, { onboardingCompleted: false }); },
  });
  const kydogHome = launched.kydogHome;
  try {
    const { page } = launched;
    // 首次真·全新 HOME 冷启动（无既有 kydog.json/skills 缓存）偶尔比其它 spec 慢，放宽超时避免偶发抖动。
    await expect(page.locator('[data-testid="onboarding-root"]')).toBeVisible({ timeout: 10_000 });

    await page.locator('[data-testid="onboarding-next"]').click();            // 第0步 语言：取预选，直接下一步
    await page.locator('[data-testid="onboarding-username"]').fill('Dr. Zhang');
    await page.locator('[data-testid="onboarding-agentname"]').fill('狗哥');
    await page.locator('[data-testid="onboarding-next"]').click();            // 第1步 称呼
    await page.locator('[data-testid="onboarding-next"]').click();            // 第2步 模型（已配置 → next 放行）
    await page.locator('[data-testid="onboarding-theme-midnight"]').click();
    await page.locator('[data-testid="onboarding-next"]').click();            // 第3步 外观
    // 统计勾选默认打勾（刻意的产品决定，见 OnboardingWizard.tsx 的注释），下面不动它，
    // 好让落盘断言证明这个默认值真的一路传到了 settings。
    await expect(page.locator('[data-testid="onboarding-telemetry"]')).toBeChecked();
    await page.locator('[data-testid="onboarding-finish"]').click();          // 第4步 完成

    await expect(page.locator('[data-testid="onboarding-root"]')).toBeHidden({ timeout: 10_000 });

    const home = path.join(kydogHome, '.kydog');
    const user = await fs.readFile(path.join(home, 'USER.md'), 'utf8');
    const soul = await fs.readFile(path.join(home, 'SOUL.md'), 'utf8');
    await fs.access(path.join(home, 'AGENTS.md'));
    expect(user).toContain('name: "Dr. Zhang"');
    expect(soul).toContain('name: "狗哥"');
    const settings = JSON.parse(await fs.readFile(path.join(home, 'kydog.json'), 'utf8'));
    expect(settings.onboarding.completedAt).toBeTruthy();
    expect(settings.ui.theme).toBe('midnight');
    // 勾选结果落盘 —— 这条断言存在的理由是曾有过一个 telemetryEnabled: false 的占位，
    // 它让每个走完向导的用户都被记成「明确拒绝」，而 UI 上根本没有可拒绝的东西。
    expect(settings.telemetry.state).toBe('enabled');
    // 但 e2e 下闸门是关的：enabled 也不该在本地留下任何标识文件。
    await expect(fs.access(path.join(home, 'install-id'))).rejects.toThrow();

    // 上面测的是磁盘，这里测**运行中的服务**：装配发生在启动时（那会儿还是 undecided），
    // 勾选若不同步进去，同一会话里这个开关就显示未勾选 —— 用户刚勾过。
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-about"]').click();
    await page.locator('[data-testid="about-privacy-entry"]').click();
    await expect(page.locator('[data-testid="telemetry-toggle"]')).toBeChecked();
  } finally {
    await teardown(launched);
  }

  // 二次启动：复用同一 HOME，onboarding 已完成 → 不再出向导。
  const second = await launchKydog({ kydogHome });
  try {
    // 先等主界面真正挂载（正向信号），避免 React 挂载前的瞬时 DOM 让 toHaveCount(0) 假通过。
    await expect(second.page.locator('[data-testid="title-bar"]')).toBeVisible({ timeout: 10_000 });
    await expect(second.page.locator('[data-testid="onboarding-root"]')).toHaveCount(0);
  } finally {
    await teardown(second);
  }
});

test('37b-identity: USER.md 含空格称呼在消息列表完整显示', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  const threadId = 'eeeeeeee-3737-3737-3737-373737373737';
  const launched = await launchKydog({
    fixture: 'e2e/fixtures/happy-path-text.json',
    seed: async (home) => {
      await seedProject(home, projectPath, [{ id: threadId, title: '37b thread' }]);
      await fs.writeFile(path.join(home, '.kydog', 'USER.md'), '---\nname: "Dr. Zhang"\n---\nbody');
    },
  });
  try {
    const { page } = launched;
    // 打开已有线程 + 发消息：交互序列对齐 04-send-receive-stream.spec.ts 现行写法。
    await page.getByTestId(`thread-${threadId}`).click();
    await page.locator('[data-testid="composer-input"]').fill('hi');
    await page.locator('[data-testid="send-button"]').click();
    // 完整称呼出现，且不能被截断成 "Dr."（回归含空格称呼被拆分的问题）。
    await expect(page.locator('[data-testid="message-list"]')).toContainText('Dr. Zhang');
    await expect(page.locator('[data-testid="message-list"]').getByText(/^Dr\.$/)).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});
