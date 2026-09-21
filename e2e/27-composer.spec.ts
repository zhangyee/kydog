import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchKydog, teardown, seedSamplePackage, type LaunchedApp, newThread } from './helpers';
import type { FixtureFile } from './fixtures/fixture.types';

/**
 * 输入框（contenteditable 里的 slash 菜单与 skill chip）、项目与模型 pill、技能开关。
 * 串行共用一次启动：每条从「新建对话」起一个空 thread，互不依赖输入框里的残留；
 * 技能开关那条改设置，放最后。
 *
 * 发送走 fixture（`ping` 剧本）—— 不设 fixture 就会拿假 key 真打上游 API。
 */
test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let projectA = '';
let projectB = '';

test.beforeAll(async () => {
  projectA = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-a-'));
  projectB = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-b-'));
  await seedSamplePackage(projectA);
  await seedSamplePackage(projectB);
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-fx-'));
  const fixture = path.join(fixtureDir, 'composer.json');
  const script: FixtureFile = {
    scripts: {
      ping: [
        { after_ms: 0, type: 'agent_start' },
        { after_ms: 0, type: 'message_start', messageId: 'm1' },
        { after_ms: 10, type: 'text_delta', messageId: 'm1', delta: 'pong' },
        { after_ms: 0, type: 'message_end', messageId: 'm1' },
        { after_ms: 0, type: 'agent_end', reason: 'completed' },
      ],
    },
  };
  await fs.writeFile(fixture, JSON.stringify(script));
  launched = await launchKydog({
    fixture,
    seed: async (home) => {
      await fs.mkdir(path.join(home, '.kydog'), { recursive: true });
      // 两个 provider：模型 pill 那条要能切到另一家。故意留在 v2，走一遍迁移。
      await fs.writeFile(path.join(home, '.kydog', 'kydog.json'), JSON.stringify({
        schemaVersion: 2,
        ui: { theme: 'vellum', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false },
        llm: {
          auth: { anthropic: { type: 'api_key', key: 'sk-fix-1' }, openai: { type: 'api_key', key: 'sk-fix-2' } },
          providers: { anthropic: { defaultModel: 'claude-sonnet-4-5' }, openai: { defaultModel: 'gpt-4o' } },
          customProviders: [],
          defaultProvider: 'anthropic',
          defaultModel: 'claude-sonnet-4-5',
        },
        skills: { disabledBuiltins: [] },
        tools: { externalBins: [] },
        onboarding: { completedAt: '2026-01-01T00:00:00.000Z' },
      }, null, 2));
      const now = new Date().toISOString();
      await fs.writeFile(path.join(home, '.kydog', 'index.json'), JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: projectA, addedAt: now }, { path: projectB, addedAt: now }],
        threads: [{ id: 't-24', projectPath: projectA, title: '24-test', createdAt: now, lastActiveAt: now }],
      }, null, 2));
    },
  });
});

test.afterAll(async () => {
  await teardown(launched);
  for (const d of [projectA, projectB]) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});

/**
 * 输入框的「正文」：contenteditable 里除开头 skill chip 以外的文字。
 * 与 ComposerEditor.tsx 的 parseEditor 同一套规则。
 */
async function readBodyText(page: Page): Promise<string> {
  return page.getByTestId('composer-input').evaluate((el: HTMLElement) => {
    let body = '';
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const elem = node as Element;
        if (elem.getAttribute('data-skill-chip-name')) continue;
        if (elem.tagName === 'BR') { body += '\n'; continue; }
        body += (elem as HTMLElement).innerText ?? elem.textContent ?? '';
      } else if (node.nodeType === Node.TEXT_NODE) {
        body += node.textContent ?? '';
      }
    }
    return body;
  });
}

/** 新建一个空对话，光标落进输入框。 */
async function freshComposer(page: Page) {
  await newThread(page);
  const input = page.getByTestId('composer-input');
  await input.click();
  return input;
}

/** 把光标放到输入框里第一个文本节点的开头。 */
async function caretToFirstText(page: Page) {
  await page.getByTestId('composer-input').evaluate((el: HTMLElement) => {
    const firstText = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
    if (!firstText) return;
    const range = document.createRange();
    range.setStart(firstText, 0);
    range.collapse(true);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  });
}

test('03-create-thread: clicking 新建对话 selects new thread and shows EmptyState', async () => {
  const { page } = launched;
  await newThread(page);
  await expect(page.getByTestId('chapter-literature-review')).toBeVisible();
  await expect(page.getByTestId('composer-input')).toBeVisible();
});

test('27-composer: Shift+Enter inserts newline, Enter clears editor (send fires)', async () => {
  const { page } = launched;
  const input = await freshComposer(page);
  await page.keyboard.type('hello');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('world');
  expect(await readBodyText(page)).toBe('hello\nworld');

  await input.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('ping');
  expect(await readBodyText(page)).toBe('ping');
  await page.keyboard.press('Enter');
  // 发送：输入框先乐观清空，fixture 的回复落进对话。
  await expect.poll(() => readBodyText(page)).toBe('');
  await expect(page.getByTestId('message-list')).toContainText('pong');
});

test('27-composer: typing / opens slash menu with description; Enter commits as chip', async () => {
  const { page } = launched;
  await freshComposer(page);
  await page.keyboard.type('/');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
  await expect(page.getByTestId('slash-item-fastpaper')).toBeVisible();
  await expect(page.getByTestId('slash-menu-desc')).toBeVisible();
  // Enter 提交的是高亮项，高亮起始于字母序第一个内置 skill（加一个 skill 就会换）——先过滤钉住名字。
  await page.keyboard.type('fast');
  await expect(page.getByTestId('slash-item-fastpaper')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('skill-chip')).toContainText('fastpaper');
  expect(await readBodyText(page)).toBe('');
  await expect(page.getByTestId('slash-menu')).toBeHidden();
});

test('27-composer: × button removes chip without losing existing body text', async () => {
  const { page } = launched;
  await freshComposer(page);
  await page.keyboard.type('/');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('skill-chip')).toBeVisible();
  await page.keyboard.type('hello world');
  expect(await readBodyText(page)).toBe('hello world');
  await page.getByTestId('skill-chip-remove').click();
  await expect(page.getByTestId('skill-chip')).toHaveCount(0);
  expect(await readBodyText(page)).toBe('hello world');
});

test('27-composer: committing a slash command preserves trailing body text', async () => {
  const { page } = launched;
  await freshComposer(page);
  await page.keyboard.type('/fast extra args');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
  await expect(page.getByTestId('slash-item-fastpaper')).toBeVisible();
  await page.keyboard.press('Enter');
  // chip = fastpaper，正文只去掉「/fast 」前缀。
  await expect(page.getByTestId('skill-chip')).toContainText('fastpaper');
  expect(await readBodyText(page)).toBe('extra args');
});

test('27-composer: backspace immediately after chip removes the chip; body preserved', async () => {
  const { page } = launched;
  await freshComposer(page);
  await page.keyboard.type('/');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('skill-chip')).toBeVisible();
  await page.keyboard.type('hello world');
  expect(await readBodyText(page)).toBe('hello world');
  await caretToFirstText(page);   // 紧贴在 chip 后面
  await page.keyboard.press('Backspace');
  await expect(page.getByTestId('skill-chip')).toHaveCount(0);
  expect(await readBodyText(page)).toBe('hello world');
});

test('27-composer: slash menu reopens after chip removal even when body has leading whitespace', async () => {
  const { page } = launched;
  await freshComposer(page);
  await page.keyboard.type('测试');
  await caretToFirstText(page);
  // 「/测试」：按「测试」过滤出空集，菜单收着；再补一个空格成「/ 测试」→ 过滤词为空，全部可见。
  await page.keyboard.type('/');
  await page.keyboard.type(' ');
  await expect(page.getByTestId('slash-menu')).toBeVisible();
  await expect(page.getByTestId('slash-item-fastpaper')).toBeVisible();
});

test('27-composer: project pill switches the empty thread to another project', async () => {
  const { page } = launched;
  const nameA = path.basename(projectA);
  const nameB = path.basename(projectB);
  await newThread(page);
  const pill = page.getByTestId('project-pill');
  await expect(pill).toContainText(nameA);
  await pill.click();
  await expect(page.getByTestId('project-menu')).toBeVisible();
  await expect(page.getByTestId('project-item-current')).toContainText(nameA);
  const other = page.getByTestId(`project-item-${nameB}`);
  await expect(other).toBeVisible();
  await other.click();
  await expect(page.getByTestId('project-menu')).toBeHidden();
  await expect(pill).toContainText(nameB);
  // 换过项目之后再点「新对话」：建在刚换过去的 B 里。A 是第一个项目，上面那次新对话就落在 A ——
  // 两次结果不同，说明看的是当前项目，不是写死的 projects[0]。
  await newThread(page);
  await expect(pill).toContainText(nameB);
});

test('23/24-llm: Composer 显示默认模型；pill 里切到另一家只改这个 thread', async () => {
  const { page } = launched;
  await page.getByTestId('thread-t-24').click();
  await expect(page.locator('text=/Anthropic · claude-sonnet-4-5/')).toBeVisible();
  await page.locator('text=/Anthropic · /').click();
  await page.getByText('▸ OpenAI').click();
  await page.locator('text=gpt-4o').first().click();
  await expect(page.locator('text=/OpenAI · gpt-4o/')).toBeVisible();
});

test('21-skills-page: toggling a built-in skill off persists to settings file', async () => {
  const { page, kydogHome } = launched;
  await page.getByTestId('nav-skills').click();
  // 从 DOM 读出点的是哪个 skill，别假定字母序（加一个 skill 就会换位）。
  const enabledRow = page.locator('[data-testid=skill-row]')
    .filter({ has: page.locator('[role=switch][aria-checked=true]') })
    .first();
  await enabledRow.waitFor();
  const name = await enabledRow.getAttribute('data-skill-name');
  expect(name).toBeTruthy();
  // 按名字重新定位：上面那个带「开关开着」条件，点完就不匹配这一行了。
  const row = page.locator(`[data-testid=skill-row][data-skill-name="${name}"]`);
  await row.locator('[role=switch]').click();
  await expect(row.locator('text=已禁用')).toBeVisible();
  await expect.poll(async () => {
    const s = JSON.parse(await fs.readFile(path.join(kydogHome, '.kydog', 'kydog.json'), 'utf8'));
    return s.skills.disabledBuiltins as string[];
  }).toContain(name);
});
