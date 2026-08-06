import { test, expect, type Page } from '@playwright/test';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, teardown } from './helpers';

/** 隐私与统计在关于页底部，与开源许可并列 —— 没有独立的设置页与菜单项。 */
async function openPrivacy(page: Page) {
  await page.locator('[data-testid="user-menu-trigger"]').click();
  await page.locator('[data-testid="menu-about"]').click();
  await page.locator('[data-testid="about-privacy-entry"]').click();
}

// e2e 把 HOME 设成 kydogHome，而 INSTALL_ID_FILE / LAST_BEACON_FILE 都在
// paths.ROOT = <HOME>/.kydog 下。少了 .kydog 这一层，existsSync 永远 false、
// 断言空洞通过 —— 而这类断言存在的全部理由就是「闸门失效会污染真实统计」。
const dotKydog = (home: string) => path.join(home, '.kydog');

test('44-telemetry: e2e 下闸门关闭，开关禁用且本地无标识文件', async () => {
  const launched = await launchKydog();
  const { page, kydogHome } = launched;
  try {
    await openPrivacy(page);

    // 这是本用例存在的理由：闸门失效会让 CI 与开发机持续污染真实统计。
    // 装配失败时开关整块不渲染（只剩 telemetry-error），这两条会直接超时变红，
    // 所以不必再补一条「error 不存在」。
    await expect(page.locator('[data-testid="telemetry-toggle"]')).toBeDisabled();
    await expect(page.locator('[data-testid="telemetry-dev-notice"]')).toBeVisible();

    // 闸门关着 → startSchedule() 早退 → currentId() 恒为 null → 标识区块整块不渲染。
    // 与下面的文件系统断言是同一件事的两侧：本机既不该有标识文件，也不该有标识可展示。
    await expect(page.locator('[data-testid="telemetry-install-id"]')).toHaveCount(0);

    expect(existsSync(path.join(dotKydog(kydogHome), 'install-id'))).toBe(false);
    expect(existsSync(path.join(dotKydog(kydogHome), 'last-beacon'))).toBe(false);
  } finally {
    await teardown(launched);
  }
});

test('44-telemetry: 隐私说明在关于页内可读', async () => {
  const launched = await launchKydog();
  const { page } = launched;
  try {
    await openPrivacy(page);
    const doc = page.locator('[data-testid="privacy-doc"]');
    // privacy.md 是保留名文档：不进 ABOUT_DOCS，只能从这个入口读到。glob 少认一个
    // 保留名，ABOUT_PRIVACY 就是空串、入口按钮连带消失 —— openPrivacy 会先红。
    await expect(doc).toContainText('kydog-analytics.yeezhang.im');
    await expect(doc).toContainText('Cloudflare');
    // 运维承诺那句必须原样可读：它是 Time Travel 那一节唯一的实质内容。
    await expect(doc).toContainText('本数据库永不执行 Time Travel 恢复');
  } finally {
    await teardown(launched);
  }
});

test('44-telemetry: 迁移而来的老配置不会被静默开启', async () => {
  const launched = await launchKydog({
    seed: async (home) => {
      // 一份 v6 配置：没有 telemetry 字段，模拟升级上来的老用户。
      // 落在 <home>/.kydog/kydog.json，少了这层就根本不会被读到，测的也就不是 v6 迁移。
      // 参照 helpers.ts 的 seedSettings。theme 故意用 midnight（seedSettings 默认写
      // vellum），下面拿它当锚点确认这份文件真的覆盖生效了。
      await fs.mkdir(dotKydog(home), { recursive: true });
      await fs.writeFile(path.join(dotKydog(home), 'kydog.json'), JSON.stringify({
        schemaVersion: 6,
        ui: { theme: 'midnight', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false, readingFontSize: 'medium' },
        llm: { auth: {}, providers: {}, customProviders: [], defaultProvider: null, defaultModel: null },
        skills: { disabledBuiltins: [] },
        tools: { externalBins: [] },
        research: { presets: {}, custom: [] },
        updates: { autoCheck: true, dismissedCandidateId: null },
        onboarding: { completedAt: '2026-01-01T00:00:00.000Z' },
      }, null, 2), { mode: 0o600 });
    },
  });
  const { page, kydogHome } = launched;
  try {
    // 锚点：先证明读到的确实是上面这份 v6。没有它，seed 一旦落错路径就会退回
    // seedSettings 那份 v4 —— 同样没有 telemetry 字段、同样迁移成 undecided，
    // 下面 not.toBeChecked() 会空洞通过，而 v6 迁移一行都没被测到。
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');

    await openPrivacy(page);
    await expect(page.locator('[data-testid="telemetry-toggle"]')).not.toBeChecked();
    expect(existsSync(path.join(dotKydog(kydogHome), 'install-id'))).toBe(false);
  } finally {
    await teardown(launched);
  }
});
