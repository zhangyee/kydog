import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, teardown, type LaunchedApp } from './helpers';

/**
 * Harness：启动时的模板更新询问 + 长期记忆页的查看、编辑
 * （spec: docs/superpowers/specs/2026-09-17-harness-template-update-design.md §8.2）。
 *
 * 「对话框不在」一律先等 AppShell 根节点的 data-harness-check="done"：状态是异步查的，
 * 查询回来之前断言就会通过。每条「不在」都在同一条用例里先见过它「在」。
 */

const TPL_DIR = path.join(process.cwd(), 'src', 'main', 'harness', 'templates');
/** 与 templates.ts 同一个归一化：模板以 LF 为准，Windows 签出的 CRLF 是噪声。 */
const template = async (locale: 'zh' | 'en', name: string) =>
  (await fs.readFile(path.join(TPL_DIR, locale, name), 'utf8')).replace(/\r\n/g, '\n');

/**
 * 升级前的老文件：旧模板原样写出，配一条「从旧模板写入」的记录（R3/R4：有新版本、写入后没改过）。
 * launchKydog 默认已经 seedSettings（标了引导完成、不写三份文件），seed 里只补 harness 这部分。
 * USER.md 故意不写：文件不存在的那一份启动时不问，只在页里「创建」。
 */
const OLD_AGENTS = '# AGENTS —— 操作手册（旧版）\n\n## 核验纪律\n\n- 只有这一节。\n';
const OLD_SOUL = '---\nname: "狗哥"\n---\n\n# SOUL（旧版）\n\n- 只有这一行。\n';

async function seedOldHarness(home: string) {
  const dir = path.join(home, '.kydog');
  await fs.writeFile(path.join(dir, 'AGENTS.md'), OLD_AGENTS);
  await fs.writeFile(path.join(dir, 'SOUL.md'), OLD_SOUL);
  await fs.writeFile(path.join(dir, '.harness-state.json'), JSON.stringify({
    schemaVersion: 1,
    files: {
      'AGENTS.md': { locale: 'zh', template: OLD_AGENTS, keptTemplateSha: null },
      'SOUL.md': { locale: 'zh', template: OLD_SOUL, keptTemplateSha: null },
    },
  }));
}

async function harnessChecked(page: Page) {
  await expect(page.locator('[data-harness-check="done"]')).toHaveCount(1, { timeout: 10_000 });
}

/** 长期记忆页 → 点那张卡 → 它在右侧检视栏里打开（方案 B）。 */
async function openHarness(page: Page, name: 'SOUL.md' | 'USER.md' | 'AGENTS.md') {
  await page.getByTestId('nav-long-term-memory').click();
  await expect(page.getByTestId('ltm-page')).toBeVisible();
  await page.getByTestId(`harness-card-open-${name}`).click();
  await expect(page.getByTestId(`harness-card-${name}`)).toHaveAttribute('data-opened', 'true');
  await expect(page.getByTestId('harness-inspector')).toBeVisible();
}

test.describe('启动时的模板更新', () => {
  test.describe.configure({ mode: 'serial' });
  let launched: LaunchedApp;
  let home = '';
  test.beforeAll(async () => {
    launched = await launchKydog({ seed: seedOldHarness });
    home = path.join(launched.kydogHome, '.kydog');
  });
  test.afterAll(async () => { await teardown(launched); });

  test('64a/64b 启动就逐份问：SOUL 选更新（备份 + 换新）、AGENTS 选保持（不动）；不存在的 USER.md 不问；重启不再问', async () => {
    const { page } = launched;
    await expect(page.getByTestId('harness-update-row-SOUL.md')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('harness-update-row-AGENTS.md')).toBeVisible();
    // 文件不存在的那一份启动时不问（正向：上面两份都在同一个对话框里）。
    await expect(page.getByTestId('harness-update-row-USER.md')).toHaveCount(0);
    await expect(page.getByTestId('harness-update-edit-SOUL.md')).toHaveText('写入后没改过，更新不会丢失任何内容');
    // 两个选项都不预选：每一份都选了之前「确定」点不了。
    const confirm = page.getByTestId('harness-update-confirm');
    await expect(confirm).toBeDisabled();
    await page.getByTestId('harness-choice-SOUL.md-update').check();
    await expect(confirm).toBeDisabled();
    await page.getByTestId('harness-choice-AGENTS.md-keep').check();
    await expect(confirm).toBeEnabled();
    await confirm.click();

    const soulResult = page.getByTestId('harness-update-result-SOUL.md');
    await expect(soulResult).toContainText('已更新，旧文件备份为 ~/.kydog/SOUL.md.bak-');
    await expect(page.getByTestId('harness-update-result-AGENTS.md')).toContainText('已保持');
    const backupName = /~\/\.kydog\/(SOUL\.md\.bak-[\d-]+)/.exec(await soulResult.innerText())![1];
    expect(await fs.readFile(path.join(home, backupName), 'utf8')).toBe(OLD_SOUL);
    expect(await fs.readFile(path.join(home, 'SOUL.md'), 'utf8')).not.toBe(OLD_SOUL);
    expect(await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8')).toBe(OLD_AGENTS);
    await page.getByTestId('harness-update-done').click();
    await expect(page.getByTestId('harness-update-dialog')).toHaveCount(0);

    // 重启：都有了终态（更新 / 保持），不再问（正向：同一个 HOME 第一次启动时，上面对话框在）。
    await teardown(launched);
    launched = await launchKydog({ kydogHome: launched.kydogHome });
    await harnessChecked(launched.page);
    await expect(launched.page.getByTestId('harness-update-dialog')).toHaveCount(0);
  });

  test('64b/64c 重启之后的页里：更新过的已是最新、保持的显示「你选过保持」且仍能更新、不存在的能「创建」', async () => {
    const { page } = launched;   // 上一条末尾已经重启过
    await page.getByTestId('nav-long-term-memory').click();
    await expect(page.getByTestId('harness-card-status-SOUL.md')).toHaveText('已是最新');
    await expect(page.getByTestId('harness-card-status-AGENTS.md')).toHaveText('选过保持');

    // 改主意：页里点更新 → confirm() → 备份 + 换成新模板（逐字等于当前模板）。
    await openHarness(page, 'AGENTS.md');
    await expect(page.getByTestId('harness-status')).toHaveText('有新版本（你选过保持）');
    await expect(page.getByTestId('harness-body')).toContainText('只有这一节。');
    await page.getByTestId('harness-update').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('写入后没改过');
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByTestId('harness-status')).toHaveText('已是最新');
    await expect(page.getByTestId('harness-note')).toContainText('已更新，旧文件备份为 ~/.kydog/AGENTS.md.bak-');
    expect(await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8')).toBe(await template('zh', 'AGENTS.md'));

    // 文件不存在：页里显示「创建」，点了直接写入模板（不备份、不问）。
    await openHarness(page, 'USER.md');
    await expect(page.getByTestId('harness-status')).toHaveText('文件不存在');
    await expect(page.getByTestId('harness-update')).toHaveText('创建');
    await page.getByTestId('harness-update').click();
    await expect(page.getByTestId('harness-status')).toHaveText('已是最新');
    await expect.poll(() => fs.access(path.join(home, 'USER.md')).then(() => true, () => false)).toBe(true);
  });
});

test.describe('长期记忆页', () => {
  test.describe.configure({ mode: 'serial' });
  let launched: LaunchedApp;
  let soul = '';
  let agents = '';
  test.beforeAll(async () => {
    soul = (await template('zh', 'SOUL.md')).replace('{{agentName}}', JSON.stringify('狗哥'));
    agents = await template('zh', 'AGENTS.md');
    launched = await launchKydog({
      seed: async (home) => {
        // 等于当前模板 → 启动时不问。USER.md 不写。
        await fs.writeFile(path.join(home, '.kydog', 'SOUL.md'), soul);
        await fs.writeFile(path.join(home, '.kydog', 'AGENTS.md'), agents);
      },
    });
    await harnessChecked(launched.page);
  });
  test.afterAll(async () => { await teardown(launched); });
  const fileOf = (name: string) => path.join(launched.kydogHome, '.kydog', name);

  test('64d 编辑 SOUL.md：原样保存（字节一致、头部 name 完好）；编辑到一半离开页面再回来，草稿还在', async () => {
    const { page } = launched;
    await page.getByTestId('nav-long-term-memory').click();
    await expect(page.getByTestId('harness-card-status-SOUL.md')).toHaveText('已是最新');
    // 卡片悬停才出操作：悬停前「编辑」不可见，悬停后可见（同一个按钮）。必须在这次启动里点任何卡片
    // 之前断：点过之后焦点留在卡片里，focus-within 也会让操作一直显示（给键盘用的）。
    await expect(page.getByTestId('harness-card-edit-SOUL.md')).toBeHidden();
    await page.getByTestId('harness-card-SOUL.md').hover();
    await page.getByTestId('harness-card-edit-SOUL.md').click();
    await expect(page.getByTestId('harness-inspector')).toBeVisible();
    await expect(page.getByTestId('harness-status')).toHaveText('已是最新');
    await expect(page.getByTestId('harness-frontmatter-name')).toHaveText('称呼：狗哥');
    const editor = page.getByTestId('harness-editor');
    await expect(editor).toHaveValue(soul);                                // 整份原样，含头部
    const mine = soul.replace('## 语气', '## 语气\n\n- 回答里多用比喻。\n');
    await editor.fill(mine);
    await expect(page.getByTestId('harness-dirty-SOUL.md')).toBeVisible();

    // 离开这一页（换到「技能和工具」，长期记忆页卸载、检视栏回到平常的内容）再回来。
    await page.getByTestId('nav-skills').click();
    await expect(page.getByTestId('ltm-page')).toHaveCount(0);
    await expect(page.getByTestId('harness-inspector')).toHaveCount(0);
    await page.getByTestId('nav-long-term-memory').click();
    await expect(page.getByTestId('harness-editor')).toHaveValue(mine);
    expect(await fs.readFile(fileOf('SOUL.md'), 'utf8')).toBe(soul);        // 还没存

    await page.getByTestId('harness-save').click();
    await expect(page.getByTestId('harness-note')).toContainText('已保存');
    expect(await fs.readFile(fileOf('SOUL.md'), 'utf8')).toBe(mine);
    await expect(page.getByTestId('harness-frontmatter-name')).toHaveText('称呼：狗哥');
    await expect(page.getByTestId('harness-body')).toContainText('回答里多用比喻');
    await expect(page.getByTestId('harness-body')).toContainText('陌生不等于浅薄');
    await expect(page.getByTestId('harness-body')).not.toContainText('name:');      // 头部不当正文渲染
    await expect(page.getByTestId('harness-dirty-SOUL.md')).toHaveCount(0);
  });

  test('64e 保存冲突：编辑期间磁盘被改 → 保存弹确认；返回编辑什么都不动，覆盖后磁盘等于草稿', async () => {
    const { page } = launched;
    await openHarness(page, 'AGENTS.md');
    await page.getByTestId('harness-edit').click();
    const mine = agents + '\n## 我加的\n\n- 一条。\n';
    await page.getByTestId('harness-editor').fill(mine);

    const agentWrote = agents + '\n## agent 按用户要求加的\n';
    await fs.writeFile(fileOf('AGENTS.md'), agentWrote);                   // 这期间 agent 改了它

    await page.getByTestId('harness-save').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('在你编辑期间被改过');
    await expect(page.getByTestId('confirm-dialog-cancel')).toHaveText('返回编辑');
    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    expect(await fs.readFile(fileOf('AGENTS.md'), 'utf8')).toBe(agentWrote);   // 没覆盖
    await expect(page.getByTestId('harness-editor')).toHaveValue(mine);        // 草稿还在

    await page.getByTestId('harness-save').click();
    await expect(page.getByTestId('confirm-dialog-confirm')).toHaveText('用我的版本覆盖');
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByTestId('harness-note')).toContainText('已保存');
    expect(await fs.readFile(fileOf('AGENTS.md'), 'utf8')).toBe(mine);
  });

  test('64g 编辑过、关掉，再点「查看」是查看态；改过没存的：关掉先问、查看时提示「继续编辑」', async () => {
    const { page } = launched;
    const card = page.getByTestId('harness-card-SOUL.md');
    const editor = page.getByTestId('harness-editor');
    // 以盘上现在的内容为准（64d 存过一版）。
    const base = await fs.readFile(fileOf('SOUL.md'), 'utf8');

    // 1) 卡片上点编辑 → 关掉 → 再点查看，出来的必须是查看态。
    await card.hover();
    await page.getByTestId('harness-card-edit-SOUL.md').click();
    await expect(editor).toBeVisible();
    await page.getByTestId('harness-inspector-close').click();              // 没改过，直接关、不问
    await expect(page.getByTestId('harness-inspector')).toHaveCount(0);
    await card.hover();
    await page.getByTestId('harness-card-view-SOUL.md').click();
    await expect(page.getByTestId('harness-body')).toContainText('陌生不等于浅薄');
    await expect(editor).toHaveCount(0);

    // 2) 改过没存就关：先问；「继续编辑」什么都不动，「放弃修改」才关。
    await page.getByTestId('harness-edit').click();
    await editor.fill(base + '\n我加的一句\n');
    await page.getByTestId('harness-inspector-close').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('放弃未保存的修改');
    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(editor).toHaveValue(base + '\n我加的一句\n');
    await page.getByTestId('harness-inspector-close').click();
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByTestId('harness-inspector')).toHaveCount(0);
    await expect(page.getByTestId('harness-dirty-SOUL.md')).toHaveCount(0);
    expect(await fs.readFile(fileOf('SOUL.md'), 'utf8')).toBe(base);

    // 3) 改到一半去看别的，回来点查看：是查看态，但提示有没保存的修改，「继续编辑」接着改那一份。
    await card.hover();
    await page.getByTestId('harness-card-edit-SOUL.md').click();
    await editor.fill(base + '\n改到一半\n');
    await page.getByTestId('harness-card-open-USER.md').click();
    await expect(page.getByTestId('harness-status')).toHaveText('文件不存在');
    await expect(page.getByTestId('harness-dirty-SOUL.md')).toBeVisible();
    await page.getByTestId('harness-card-open-SOUL.md').click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByTestId('harness-pending-draft')).toBeVisible();
    await expect(page.getByTestId('harness-body')).not.toContainText('改到一半');      // 查看态显示的是磁盘上的
    await page.getByTestId('harness-edit').click();
    await expect(page.getByTestId('harness-edit')).toHaveCount(0);
    await expect(editor).toHaveValue(base + '\n改到一半\n');
  });

  test('64f 长期记忆页：Memory 三个标签灰掉占位；检视栏收着时点卡片会展开它', async () => {
    const { page } = launched;
    // 与 Memory 对齐，上面那一节就叫 Harness，不叫 KyDog Harness。
    await expect(page.getByTestId('ltm-page')).toContainText('Harness · 每次新对话都读');
    await expect(page.getByTestId('ltm-page')).not.toContainText('KyDog Harness');
    // Memory 的标题与标签整体压淡；上面 Harness 那一节不淡（对照）。
    await expect(page.getByTestId('ltm-memory-head')).toHaveCSS('opacity', '0.5');
    await expect(page.getByRole('region', { name: 'Harness' })).toHaveCSS('opacity', '1');
    for (const id of ['graph', 'daily', 'global']) {
      await expect(page.getByTestId(`ltm-memory-tab-${id}`)).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByTestId(`ltm-memory-tab-${id}`)).toHaveAttribute('title', '暂未开放');
    }
    // 先把检视栏收起来：收着的时候看不到 harness 检视；点卡片会把它展开。
    await page.getByTestId('collapse-inspector').click();
    await expect(page.getByTestId('harness-inspector')).toHaveCount(0);
    await page.getByTestId('harness-card-open-USER.md').click();
    await expect(page.getByTestId('harness-inspector')).toBeVisible();
    await expect(page.getByTestId('harness-status')).toHaveText('文件不存在');
    await page.getByTestId('harness-inspector-close').click();
    await expect(page.getByTestId('harness-inspector')).toHaveCount(0);
    await expect(page.getByTestId('harness-card-USER.md')).toHaveAttribute('data-opened', 'false');
  });
});
