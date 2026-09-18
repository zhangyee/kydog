import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchKydog, teardown, seedSettings, type LaunchedApp } from './helpers';
import { selectPath } from './fixtures/oauth-mock';

/**
 * 首次真实使用：onboarding 已完成、还没配 provider。一次启动里依次走：外壳与 DevTools 守卫、
 * PATH、OAuth 登录（先选方式 → 授权页 → 取消）、云 provider 写进主进程 env、加 API key provider。
 *
 * 串行共用一次启动：后几条会改设置（加 provider），前面的「列表为空」只在开头成立，
 * 顺序不能打乱。每条仍是独立的 test，报告里各自出名字。
 */
test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;

test.beforeAll(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-oauth-'));
  const oauthFixture = path.join(dir, 'select.json');
  // selectPath 永不完成（successAfterMs 999_999）：选完停在授权页，取消才有东西可取消。
  await fs.writeFile(oauthFixture, JSON.stringify(selectPath));
  launched = await launchKydog({
    seed: (home) => seedSettings(home, { providerConfigured: false }),
    env: { KYDOG_OAUTH_FIXTURE: oauthFixture },
  });
});

test.afterAll(async () => { await teardown(launched); });

/** 回到 provider 列表并确认真的在列表上（「+ 添加 provider」只在列表页有）。 */
async function backToList(): Promise<void> {
  const { page } = launched;
  await page.getByRole('button', { name: '‹ 返回' }).click();
  await expect(page.getByRole('button', { name: '+ 添加 provider' })).toBeVisible();
}

test('00-shell: app boots; three panes render; theme applies; settings pane force-opens on first run', async () => {
  const { page, app } = launched;
  await expect(page.locator('[data-pane="workspace"]')).toBeVisible();
  await expect(page.locator('[data-pane="main"]')).toBeVisible();
  await expect(page.locator('[data-pane="inspector"]')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'vellum');
  // 没配 provider：bootstrap 自动打开设置页的 provider 列表。
  await expect(page.locator('[data-testid="tab-__settings__"]')).toBeVisible();
  await expect(page.getByText('还未配置任何 provider')).toBeVisible();

  // e2e 跑的是未打包的 main.js，dev 模式会在 loadFile 之后开一个分离的 DevTools 窗口。
  // 它在 macOS 上会成为 key window，主窗口随即 blur，渲染层 document.hasFocus() 变 false；
  // 这个 blur 落在哪一相位由启动速度决定，撞进「最后一次点击 → toBeFocused 首轮」之间就是
  // 34-thread-rename / 18-projects-sidebar 那种间歇红（main.ts 里 openDevTools 处有全文）。
  // 这里守的是源头：整个应用里只有主窗口这一份 webContents，没有 DevTools 的那份。
  // 检查点放在 load 之后——openDevTools 恰好挂在 did-finish-load 上，DevTools 的
  // webContents 是在那一刻同步建出来的，所以 load 一过它要么已经在列表里、要么永远不会有。
  await page.waitForLoadState('load');
  const webContentsTypes = await app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().map((wc) => wc.getType()),
  );
  expect(webContentsTypes).toEqual(['window']);
});

test('20-fastpaper-bin: PATH head is the bundled fastpaper directory', async () => {
  const main = await launched.app.evaluate(({ app }) => {
    const sep = process.platform === 'win32' ? ';' : ':';
    return {
      isPackaged: app.isPackaged,
      pathHead: process.env.PATH?.split(sep)[0],
      resourcesPath: process.resourcesPath,
    };
  });
  if (main.isPackaged) {
    expect(main.pathHead).toBe(main.resourcesPath);
  } else {
    expect(main.pathHead).toMatch(/[\\/]vendor[\\/]current$/);
  }
});

test('44/26-llm: OAuth 先选登录方式、选完才出授权链接；取消回到登录', async () => {
  const { page } = launched;
  await page.getByRole('button', { name: '+ 添加 provider' }).click();
  await page.getByText('ChatGPT (Codex)', { exact: true }).click();
  await page.getByRole('button', { name: '登录' }).click();

  // select 早于 auth_url：此刻只有选项，没有授权链接那一块（正向证明在下面选完之后）。
  // exact 必须加：状态行是「等待选择登录方式…」，非 exact 会同时命中它和区块标签。
  await expect(page.getByText('选择登录方式', { exact: true })).toBeVisible();
  await expect(page.getByText('Select OpenAI Codex login method:')).toBeVisible();
  await expect(page.getByText('复制链接')).toHaveCount(0);
  const browserBtn = page.getByRole('button', { name: 'Browser login (default)' });
  await expect(browserBtn).toBeVisible();
  await expect(page.getByRole('button', { name: 'Device code login (headless)' })).toBeVisible();

  await browserBtn.click();
  await expect(page.getByText('复制链接')).toBeVisible();
  await expect(page.getByText('选择登录方式', { exact: true })).toHaveCount(0);

  // 取消回到 idle：登录键回来，授权链接那一块收掉。
  await page.getByRole('button', { name: '取消' }).click();
  await expect(page.getByRole('button', { name: '登录' })).toBeVisible();
  await expect(page.getByText('复制链接')).toHaveCount(0);
  await backToList();
});

test('25-llm: save Bedrock IAM keys → main process.env reflects', async () => {
  const { page, app } = launched;
  await page.getByRole('button', { name: '+ 添加 provider' }).click();
  await page.getByText('Amazon Bedrock', { exact: true }).click();

  await page.getByLabel('iamKeys').check();
  await page.getByPlaceholder('AKIA…').fill('AKIATEST');
  await page.locator('input[type="password"]').first().fill('secrettest');
  await page.getByPlaceholder('us-east-1').fill('us-east-1');
  await page.getByRole('button', { name: '保存' }).click();

  // 主进程的 process.env（app.evaluate 跑在主进程）。轮询到位，不靠固定等待。
  await expect.poll(() => app.evaluate(() => ({
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? null,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? null,
    AWS_REGION: process.env.AWS_REGION ?? null,
  })), { message: 'CloudForm 保存后主进程 env 应当是刚填的三项' }).toEqual({
    AWS_ACCESS_KEY_ID: 'AKIATEST',
    AWS_SECRET_ACCESS_KEY: 'secrettest',
    AWS_REGION: 'us-east-1',
  });
  await backToList();
});

test('22-llm: add Anthropic key shows entry in list', async () => {
  const { page } = launched;
  await page.getByRole('button', { name: '+ 添加 provider' }).click();
  await page.getByText('Anthropic', { exact: true }).click();

  // 保存前模型选单里是「先保存 API Key」这一项；保存落地（配置生效、refresh 过）它就换成模型 ——
  // 用它当「保存完了」的信号，不用固定等待。它是 <option>，只能数个数，不能断 visible。
  const notSaved = page.locator('option', { hasText: '先保存 API Key' });
  await expect(notSaved).toHaveCount(1);
  await page.locator('input[type="password"]').first().fill('sk-ant-test');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(notSaved).toHaveCount(0);

  await backToList();
  await expect(page.getByText('Anthropic', { exact: true })).toBeVisible();
});
