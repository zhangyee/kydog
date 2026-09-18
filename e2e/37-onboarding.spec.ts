import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, teardown, seedSettings } from './helpers';

test('37a-onboarding: 首启向导 → 自定义称呼走完 → 三文件与设置落盘', async () => {
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

    // 「运行中的开关同步了勾选」由 handlers.test（complete 后同步进服务）与 telemetryService.test 守；
    // 「二次启动不再出向导」就是其余每条 e2e 走的默认启动路径。
  } finally {
    await teardown(launched);
  }
});
