import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchKydog, teardown, type LaunchedApp } from './helpers';

/**
 * 自动更新：fixture 驱动出横幅、忽略后消失；关于页的更新块与自动检查开关落盘。
 * 串行共用一次启动（更新 fixture 走 env，不影响开关那条）。
 */
test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let fixtureDir = '';

test.beforeAll(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-update-fixture-'));
  const fixturePath = path.join(fixtureDir, 'outcome.json');
  await fs.writeFile(fixturePath, JSON.stringify({ kind: 'available', candidateId: 'c1', label: 'KyDog 9.9.9' }));
  // launchKydog 的 fixture 选项是 agent fixture，另一回事；更新 fixture 走 env。
  launched = await launchKydog({ env: { KYDOG_UPDATE_FIXTURE: fixturePath } });
});

test.afterAll(async () => {
  await teardown(launched);
  await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
});

test('42-auto-update: fixture 驱动出横幅，忽略后消失', async () => {
  const { page } = launched;
  await expect(page.locator('[data-pane="main"]')).toBeVisible();
  const banner = page.getByTestId('update-banner');
  await expect(banner).toBeHidden();
  // 自动检查要等启动后 30 秒：直接调「立即检查」走的同一条 update.check，状态靠 update.status 广播回流。
  await page.evaluate(async () => { await window.kydog.invoke('update.check'); });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('KyDog 9.9.9');
  await page.getByTestId('update-banner-dismiss').click();
  await expect(banner).toBeHidden();
});

test('42-auto-update: 关于页更新块常驻，自动检查开关落盘', async () => {
  const { page, kydogHome } = launched;
  await page.getByTestId('user-menu-trigger').click();
  await page.getByTestId('menu-about').click();
  await expect(page.getByTestId('update-block')).toBeVisible();
  // 版本号只在设置页头部渲染一份，更新块里没有（见 UpdateBlock.tsx 的注释）。
  await expect(page.getByTestId('settings-version')).toContainText('v');

  const toggle = page.getByTestId('update-block').getByRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');   // 默认开
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  // 开关走 UpdateService 自己的队列 + withLock 写盘，对渲染进程是异步的 —— 轮询。
  await expect.poll(async () => {
    const raw = await fs.readFile(path.join(kydogHome, '.kydog', 'kydog.json'), 'utf8');
    return (JSON.parse(raw) as { updates: { autoCheck: boolean } }).updates.autoCheck;
  }).toBe(false);
});
