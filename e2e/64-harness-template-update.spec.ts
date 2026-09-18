import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, teardown } from './helpers';

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
 * 升级前的老 AGENTS.md：旧模板原样写出（AGENTS 没有占位符），配一条「从旧模板写入」的记录。
 * launchKydog 默认已经 seedSettings（标了引导完成、不写三份文件），seed 里只补 harness 这部分。
 */
const OLD_AGENTS = '# AGENTS —— 操作手册（旧版）\n\n## 核验纪律\n\n- 只有这一节。\n';

async function seedOldAgents(home: string) {
  const dir = path.join(home, '.kydog');
  await fs.writeFile(path.join(dir, 'AGENTS.md'), OLD_AGENTS);
  await fs.writeFile(path.join(dir, '.harness-state.json'), JSON.stringify({
    schemaVersion: 1,
    files: { 'AGENTS.md': { locale: 'zh', template: OLD_AGENTS, keptTemplateSha: null } },
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

test('64a 更新：旧模板写的 AGENTS.md → 启动就问 → 选更新 → 新文件逐字等于当前模板、备份逐字等于旧文件 → 重启不再问', async () => {
  const first = await launchKydog({ seed: seedOldAgents });
  const home = path.join(first.kydogHome, '.kydog');
  try {
    const { page } = first;
    await expect(page.getByTestId('harness-update-row-AGENTS.md')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('harness-update-edit-AGENTS.md')).toHaveText('写入后没改过，更新不会丢失任何内容');
    // 两个选项都不预选：没选之前「确定」点不了
    await expect(page.getByTestId('harness-update-confirm')).toBeDisabled();
    await page.getByTestId('harness-choice-AGENTS.md-update').check();
    await expect(page.getByTestId('harness-update-confirm')).toBeEnabled();
    await page.getByTestId('harness-update-confirm').click();

    const result = page.getByTestId('harness-update-result-AGENTS.md');
    await expect(result).toContainText('已更新，旧文件备份为 ~/.kydog/AGENTS.md.bak-');
    const backupName = /~\/\.kydog\/(AGENTS\.md\.bak-[\d-]+)/.exec(await result.innerText())![1];
    expect(await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8')).toBe(await template('zh', 'AGENTS.md'));
    expect(await fs.readFile(path.join(home, backupName), 'utf8')).toBe(OLD_AGENTS);

    await page.getByTestId('harness-update-done').click();
    await expect(page.getByTestId('harness-update-dialog')).toHaveCount(0);
  } finally {
    await teardown(first);
  }

  const second = await launchKydog({ kydogHome: first.kydogHome });
  try {
    await harnessChecked(second.page);
    await expect(second.page.getByTestId('harness-update-dialog')).toHaveCount(0);
  } finally {
    await teardown(second);
  }
});

test('64b 保持：选保持 → 文件不动 → 重启不再问 → 长期记忆页里显示「你选过保持」，点更新仍能换成新模板', async () => {
  const first = await launchKydog({ seed: seedOldAgents });
  const home = path.join(first.kydogHome, '.kydog');
  try {
    const { page } = first;
    await page.getByTestId('harness-choice-AGENTS.md-keep').check({ timeout: 10_000 });
    await page.getByTestId('harness-update-confirm').click();
    await expect(page.getByTestId('harness-update-result-AGENTS.md')).toContainText('已保持');
    await page.getByTestId('harness-update-done').click();
    expect(await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8')).toBe(OLD_AGENTS);
  } finally {
    await teardown(first);
  }

  const second = await launchKydog({ kydogHome: first.kydogHome });
  try {
    const { page } = second;
    await harnessChecked(page);
    await expect(page.getByTestId('harness-update-dialog')).toHaveCount(0);

    await page.getByTestId('nav-long-term-memory').click();
    await expect(page.getByTestId('harness-card-status-AGENTS.md')).toHaveText('选过保持');
    await openHarness(page, 'AGENTS.md');
    await expect(page.getByTestId('harness-status')).toHaveText('有新版本（你选过保持）');
    await expect(page.getByTestId('harness-body')).toContainText('只有这一节。');
    // 改主意：页里点更新 → confirm() → 备份 + 换新
    await page.getByTestId('harness-update').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('写入后没改过');
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByTestId('harness-status')).toHaveText('已是最新');
    await expect(page.getByTestId('harness-note')).toContainText('已更新，旧文件备份为 ~/.kydog/AGENTS.md.bak-');
    expect(await fs.readFile(path.join(home, 'AGENTS.md'), 'utf8')).toBe(await template('zh', 'AGENTS.md'));
  } finally {
    await teardown(second);
  }
});

test('64c 文件不存在不在启动时问：同一个 HOME 里有旧 AGENTS.md 时会问，删掉它再启动就不问，页里显示「创建」', async () => {
  const first = await launchKydog({ seed: seedOldAgents });
  try {
    await expect(first.page.getByTestId('harness-update-row-AGENTS.md')).toBeVisible({ timeout: 10_000 });
    await first.page.getByTestId('harness-update-later').click();   // 稍后再说：什么都不记
  } finally {
    await teardown(first);
  }
  // 只翻这一个条件：文件没了（seedSettings 本来就不写三份文件，现有 e2e 都是这个样子）
  await fs.rm(path.join(first.kydogHome, '.kydog', 'AGENTS.md'));

  const second = await launchKydog({ kydogHome: first.kydogHome });
  try {
    const { page } = second;
    await harnessChecked(page);
    await expect(page.getByTestId('harness-update-dialog')).toHaveCount(0);
    await openHarness(page, 'AGENTS.md');
    await expect(page.getByTestId('harness-status')).toHaveText('文件不存在');
    await expect(page.getByTestId('harness-update')).toHaveText('创建');
    await page.getByTestId('harness-update').click();
    await expect(page.getByTestId('harness-status')).toHaveText('已是最新');
    expect(await fs.readFile(path.join(second.kydogHome, '.kydog', 'AGENTS.md'), 'utf8')).toBe(await template('zh', 'AGENTS.md'));
  } finally {
    await teardown(second);
  }
});

test('64d 编辑 SOUL.md：原样保存（字节一致、头部 name 完好）；编辑到一半离开页面再回来，草稿还在', async () => {
  const soul = (await template('zh', 'SOUL.md')).replace('{{agentName}}', JSON.stringify('狗哥'));
  const launched = await launchKydog({
    seed: async (home) => {
      await fs.writeFile(path.join(home, '.kydog', 'SOUL.md'), soul);   // 等于当前模板 → 不问
    },
  });
  const file = path.join(launched.kydogHome, '.kydog', 'SOUL.md');
  try {
    const { page } = launched;
    await harnessChecked(page);
    await page.getByTestId('nav-long-term-memory').click();
    await expect(page.getByTestId('harness-card-status-SOUL.md')).toHaveText('已是最新');
    // 卡片悬停才出操作：悬停前「编辑」不可见，悬停后可见（同一个按钮）。
    // 必须在点卡片之前断：点过之后焦点留在卡片里，focus-within 也会让操作一直显示（给键盘用的）。
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

    // 离开这一页（设置页换到「技能和工具」，长期记忆页卸载、检视栏回到平常的内容）再回来
    await page.getByTestId('nav-skills').click();
    await expect(page.getByTestId('ltm-page')).toHaveCount(0);
    await expect(page.getByTestId('harness-inspector')).toHaveCount(0);
    await page.getByTestId('nav-long-term-memory').click();
    await expect(page.getByTestId('harness-editor')).toHaveValue(mine);
    expect(await fs.readFile(file, 'utf8')).toBe(soul);                    // 还没存

    await page.getByTestId('harness-save').click();
    await expect(page.getByTestId('harness-note')).toContainText('已保存');
    expect(await fs.readFile(file, 'utf8')).toBe(mine);
    await expect(page.getByTestId('harness-frontmatter-name')).toHaveText('称呼：狗哥');
    await expect(page.getByTestId('harness-body')).toContainText('回答里多用比喻');
    await expect(page.getByTestId('harness-body')).toContainText('陌生不等于浅薄');
    await expect(page.getByTestId('harness-body')).not.toContainText('name:');      // 头部不当正文渲染
    await expect(page.getByTestId('harness-dirty-SOUL.md')).toHaveCount(0);
  } finally {
    await teardown(launched);
  }
});

test('64e 保存冲突：编辑期间磁盘被改 → 保存弹确认；返回编辑什么都不动，覆盖后磁盘等于草稿', async () => {
  const agents = await template('zh', 'AGENTS.md');
  const launched = await launchKydog({
    seed: async (home) => {
      await fs.writeFile(path.join(home, '.kydog', 'AGENTS.md'), agents);
    },
  });
  const file = path.join(launched.kydogHome, '.kydog', 'AGENTS.md');
  try {
    const { page } = launched;
    await harnessChecked(page);
    await openHarness(page, 'AGENTS.md');
    await page.getByTestId('harness-edit').click();
    const mine = agents + '\n## 我加的\n\n- 一条。\n';
    await page.getByTestId('harness-editor').fill(mine);

    const agentWrote = agents + '\n## agent 按用户要求加的\n';
    await fs.writeFile(file, agentWrote);                                  // 这期间 agent 改了它

    await page.getByTestId('harness-save').click();
    await expect(page.getByTestId('confirm-dialog')).toContainText('在你编辑期间被改过');
    await expect(page.getByTestId('confirm-dialog-cancel')).toHaveText('返回编辑');
    await page.getByTestId('confirm-dialog-cancel').click();
    await expect(page.getByTestId('confirm-dialog')).toHaveCount(0);
    expect(await fs.readFile(file, 'utf8')).toBe(agentWrote);              // 没覆盖
    await expect(page.getByTestId('harness-editor')).toHaveValue(mine);    // 草稿还在

    await page.getByTestId('harness-save').click();
    await expect(page.getByTestId('confirm-dialog-confirm')).toHaveText('用我的版本覆盖');
    await page.getByTestId('confirm-dialog-confirm').click();
    await expect(page.getByTestId('harness-note')).toContainText('已保存');
    expect(await fs.readFile(file, 'utf8')).toBe(mine);
  } finally {
    await teardown(launched);
  }
});

test('64f 长期记忆页：Memory 三个标签灰掉占位；检视栏收着时点卡片会展开它', async () => {
  const launched = await launchKydog();
  try {
    const { page } = launched;
    await harnessChecked(page);
    await page.getByTestId('nav-long-term-memory').click();
    // 与 Memory 对齐，上面那一节就叫 Harness，不叫 KyDog Harness
    await expect(page.getByTestId('ltm-page')).toContainText('Harness · 每次新对话都读');
    await expect(page.getByTestId('ltm-page')).not.toContainText('KyDog Harness');
    // Memory 的标题与标签整体压淡；上面 Harness 那一节不淡（对照）
    await expect(page.getByTestId('ltm-memory-head')).toHaveCSS('opacity', '0.5');
    await expect(page.getByRole('region', { name: 'Harness' })).toHaveCSS('opacity', '1');
    for (const id of ['graph', 'daily', 'global']) {
      await expect(page.getByTestId(`ltm-memory-tab-${id}`)).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByTestId(`ltm-memory-tab-${id}`)).toHaveAttribute('title', '暂未开放');
    }
    // 先把检视栏收起来：收着的时候看不到 harness 检视
    await page.getByTestId('collapse-inspector').click();
    await expect(page.getByTestId('harness-inspector')).toHaveCount(0);
    await page.getByTestId('harness-card-open-USER.md').click();
    await expect(page.getByTestId('harness-inspector')).toBeVisible();
    await expect(page.getByTestId('harness-status')).toHaveText('文件不存在');
    await page.getByTestId('harness-inspector-close').click();
    await expect(page.getByTestId('harness-inspector')).toHaveCount(0);
    await expect(page.getByTestId('harness-card-USER.md')).toHaveAttribute('data-opened', 'false');
  } finally {
    await teardown(launched);
  }
});
