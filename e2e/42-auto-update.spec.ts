import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchKydog, teardown } from './helpers';

// 不传 KYDOG_UPDATE_FIXTURE 时 pickAssembly 落到 noop（helpers 恒定注入 KYDOG_E2E=1），
// 检查永远返回 kind:'none' —— 关于页那条只验静态块与开关，不需要任何更新态。
test('42-auto-update: 关于页更新块常驻，自动检查开关落盘', async () => {
  const launched = await launchKydog();
  const { page, kydogHome } = launched;
  try {
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="menu-about"]').click();

    await expect(page.locator('[data-testid="update-block"]')).toBeVisible();
    // 版本号只在设置页头部渲染一份，更新块里没有（见 UpdateBlock.tsx 的注释）
    await expect(page.locator('[data-testid="settings-version"]')).toContainText('v');

    const toggle = page.locator('[data-testid="update-block"]').getByRole('switch');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');   // 默认开

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    // 开关不走 settings.update，而是 UpdateService 自己的队列 + withLock 写盘，
    // 对渲染进程是异步的，所以轮询而不是读一次。
    const settingsPath = path.join(kydogHome, '.kydog', 'kydog.json');
    await expect.poll(async () => {
      const raw = await fs.readFile(settingsPath, 'utf8');
      return (JSON.parse(raw) as { updates: { autoCheck: boolean } }).updates.autoCheck;
    }).toBe(false);
  } finally {
    await teardown(launched);
  }
});

test('42-auto-update: fixture 驱动出横幅，忽略后消失', async () => {
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-update-fixture-'));
  const fixturePath = path.join(fixtureDir, 'outcome.json');
  await fs.writeFile(
    fixturePath,
    JSON.stringify({ kind: 'available', candidateId: 'c1', label: 'KyDog 9.9.9' }),
  );
  // launchKydog 的 fixture 选项是 agent fixture，另一回事；更新 fixture 走 env。
  const launched = await launchKydog({ env: { KYDOG_UPDATE_FIXTURE: fixturePath } });
  const { page } = launched;
  try {
    await expect(page.locator('[data-pane="main"]')).toBeVisible();
    const banner = page.locator('[data-testid="update-banner"]');
    await expect(banner).toBeHidden();

    // 自动检查要等启动后 30 秒，用例等不起：直接从渲染进程调 RPC，
    // 与「立即检查」按钮走的是同一条 update.check。状态回流靠 update.status 广播。
    await page.evaluate(async () => { await window.kydog.invoke('update.check'); });

    await expect(banner).toBeVisible();
    await expect(banner).toContainText('KyDog 9.9.9');

    await page.locator('[data-testid="update-banner-dismiss"]').click();
    await expect(banner).toBeHidden();
  } finally {
    await teardown(launched);
    await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
  }
});
