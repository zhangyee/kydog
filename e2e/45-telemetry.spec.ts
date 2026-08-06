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

test('45-telemetry: e2e 下闸门关闭，开关禁用且本地无标识文件', async () => {
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

// 主进程会在渲染层没发起任何调用的时候改遥测状态（启动时那次删除重试就是），
// 面板必须靠 telemetry.status 广播跟上。这里用渲染进程直接调 RPC 来制造这种
// 「不是面板发起的变化」—— 与 42-auto-update 里那条 update.status 用例同一手法。
test('45-telemetry: 状态变化经广播回流到面板，不必用户点任何东西', async () => {
  const launched = await launchKydog();
  const { page } = launched;
  try {
    await openPrivacy(page);
    const toggle = page.locator('[data-testid="telemetry-toggle"]');
    await expect(toggle).not.toBeChecked();

    await page.evaluate(async () => { await window.kydog.invoke('telemetry.setEnabled', { enabled: true }); });

    // 面板自己一次 getStatus 都没再发：这条断言只有广播能让它绿
    await expect(toggle).toBeChecked();
    // 开着就必须关得掉。闸门关着（canBeacon=false）也不能把关闭方向一起锁死 ——
    // 「用户永远能撤回同意」是这个功能的底线
    await expect(toggle).toBeEnabled();
  } finally {
    await teardown(launched);
  }
});

// 停在 deleting 的恰好是网络不稳的那批用户。启动时那次重试是 fire-and-forget，
// 面板只摆一个按钮等用户点的话，界面会一直挂着「删除请求尚未完成」。
test('45-telemetry: 进入隐私面板即重试未完成的删除，且不改写 decidedAt', async () => {
  const DECIDED_AT = '2026-01-01T00:00:00.000Z';
  const launched = await launchKydog({
    seed: async (home) => {
      // v7 直写：v6 及更早没有 telemetry 字段，迁移一律置 undecided，做不出 deleting。
      // theme 用 midnight（seedSettings 默认 vellum）当锚点，确认这份文件真的生效了。
      await fs.mkdir(dotKydog(home), { recursive: true });
      await fs.writeFile(path.join(dotKydog(home), 'kydog.json'), JSON.stringify({
        schemaVersion: 7,
        ui: { theme: 'midnight', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false, readingFontSize: 'medium' },
        llm: { auth: {}, providers: {}, customProviders: [], defaultProvider: null, defaultModel: null },
        skills: { disabledBuiltins: [] },
        tools: { externalBins: [] },
        research: { presets: {}, custom: [] },
        updates: { autoCheck: true, dismissedCandidateId: null },
        telemetry: { state: 'deleting', decidedAt: DECIDED_AT },
        onboarding: { completedAt: '2026-01-01T00:00:00.000Z' },
      }, null, 2), { mode: 0o600 });
    },
  });
  const { page, kydogHome } = launched;
  try {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
    // e2e 下闸门关着，启动时的 init() 直接早退 —— 状态能动，只可能是面板推动的
    await openPrivacy(page);

    await expect(page.locator('[data-testid="telemetry-pending-delete"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="telemetry-toggle"]')).not.toBeChecked();

    // decidedAt 必须原样留着：重试收尾不是一个新决定
    await expect.poll(async () => {
      const raw = await fs.readFile(path.join(dotKydog(kydogHome), 'kydog.json'), 'utf8');
      return (JSON.parse(raw) as { telemetry: unknown }).telemetry;
    }).toEqual({ state: 'disabled', decidedAt: DECIDED_AT });
  } finally {
    await teardown(launched);
  }
});

test('45-telemetry: 隐私说明在关于页内可读', async () => {
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
    // 关闭时一并删掉的两个本地文件必须点名 —— 用户得能自己去看它们在不在
    await expect(doc).toContainText('~/.kydog/install-id');
    await expect(doc).toContainText('~/.kydog/last-beacon');
    // 频率是省流量的约定不是承诺（实现宁可多发一次），这句不能说满
    await expect(doc).toContainText('通常每天至多一次');
  } finally {
    await teardown(launched);
  }
});

test('45-telemetry: 迁移而来的老配置不会被静默开启', async () => {
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
