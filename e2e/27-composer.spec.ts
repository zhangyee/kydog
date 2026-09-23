import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchKydog, teardown, seedSamplePackage, type LaunchedApp, newThread } from './helpers';
import type { FixtureFile, FixtureEvent } from './fixtures/fixture.types';

/**
 * 输入框（contenteditable 里的 slash 菜单与 skill chip）、项目与模型 pill、技能开关、
 * 附件（粘贴截图 / 回形针）、@ 引用、md 评论（选区工具栏与评论模式两个入口）。
 * 串行共用一次启动：每条从「新建对话」起一个空 thread，互不依赖输入框里的残留；
 * 附件、@ 与评论几条互不依赖，都从 `newThread` 起；md 评论那条会开一个文件 tab，结束时关掉。
 * 技能开关那条改设置，放最后。
 *
 * 发送走 fixture（`ping` 剧本）—— 不设 fixture 就会拿假 key 真打上游 API。
 */
test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let projectA = '';
let projectB = '';
let outsideFile = '';
let promptsFile = '';

/** 读 fixture 记下的「这一轮 agent 到底收到了什么」——每条 prompt 一行 JSON（见 fixtureProvider.ts）。 */
async function prompts(): Promise<Array<{ content: string; images: Array<{ mimeType: string; length: number }> }>> {
  const raw = await fs.readFile(promptsFile, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** 撑出可滚动高度用的长正文（120 行）。 */
const LONG_BODY = Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行：占位正文`).join('\n');

/** 剧本形状照 `ping`：agent_start → 一段文字 → agent_end。新增几条只是回复文字不同。 */
const reply = (delta: string): FixtureEvent[] => [
  { after_ms: 0, type: 'agent_start' },
  { after_ms: 0, type: 'message_start', messageId: 'm1' },
  { after_ms: 10, type: 'text_delta', messageId: 'm1', delta },
  { after_ms: 0, type: 'message_end', messageId: 'm1' },
  { after_ms: 0, type: 'agent_end', reason: 'completed' },
];

test.beforeAll(async () => {
  projectA = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-a-'));
  projectB = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-b-'));
  await seedSamplePackage(projectA);
  await seedSamplePackage(projectB);
  await fs.mkdir(path.join(projectA, 'refs'), { recursive: true });
  await fs.writeFile(path.join(projectA, 'refs', 'dpo-2023.pdf'), '%PDF-1.4\n');
  await fs.writeFile(path.join(projectA, 'refs', 'draft.pdf'), '%PDF-1.4\n');
  // 名字里带空格的文件夹：@ 列表要用两侧引号 @"Related Work/" 才进得去（spec §3.5）；两个文件用来看筛选
  await fs.mkdir(path.join(projectA, 'Related Work'), { recursive: true });
  await fs.writeFile(path.join(projectA, 'Related Work', 'survey.md'), '# survey\n');
  await fs.writeFile(path.join(projectA, 'Related Work', 'notes.md'), '# notes\n');
  // 空文件夹：进去之后列表里只有「文件夹本身」那一行（spec §3.5）
  await fs.mkdir(path.join(projectA, 'Empty Dir'), { recursive: true });
  await fs.writeFile(path.join(projectA, 'ch3.md'), '# 第三章\n\n## 3.2 偏好对齐\n\n将 β 固定为 0.1，并复现。\n');
  outsideFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-out-')), 'outside.pdf');
  await fs.writeFile(outsideFile, '%PDF-1.4\n');
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-fx-'));
  const fixture = path.join(fixtureDir, 'composer.json');
  promptsFile = `${fixture}.prompts.jsonl`;
  const script: FixtureFile = {
    scripts: {
      ping: reply('pong'),
      '看图': reply('看到了'),
      '看文件': reply('看到了'),
      '对比 <kydog-ref path="refs/dpo-2023.pdf"/> 的表 2': reply('对比完了'),
      '看 <kydog-ref path="Related Work/survey.md"/> 的结论': reply('看完了'),
      '看 <kydog-ref path="Empty Dir/"/> 里有什么': reply('是空的'),
      '看看@zzz': reply('看过了'),
      '谢谢@所有人': reply('不客气'),
      '整理批注': reply('整理完了'),
      // 跟随测试：先一段够长的正文（撑出可滚动高度），中间夹一个工具把后面的文字挤成**新的
      // text block**（旧实现正是在这一刻跳底），再隔 2.5 秒把它吐出来 —— 留出翻到顶的时间。
      '跟随测试': [
        { after_ms: 0, type: 'agent_start' },
        { after_ms: 0, type: 'message_start', messageId: 'm1' },
        { after_ms: 10, type: 'text_delta', messageId: 'm1', delta: LONG_BODY },
        { after_ms: 0, type: 'tool_start', toolCallId: 'f1', name: 'bash', command: 'true' },
        { after_ms: 0, type: 'tool_end', toolCallId: 'f1', status: 'ok', exitCode: 0 },
        { after_ms: 2500, type: 'text_delta', messageId: 'm1', delta: '\n\nTAIL_MARKER 后来的一段' },
        { after_ms: 0, type: 'message_end', messageId: 'm1', toolCallIds: ['f1'] },
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

/**
 * 空对话落在 projectA（refs/ 与 ch3.md 在那里）。「新对话」建在当前项目（最近选中的对话所在的、刚换过去的
 * 项目 —— 65ff9d6 起不再固定拿 projects[0]），前面几条先后在 projectA / projectB 里起过对话，新对话落在
 * 哪个项目取决于用例的先后次序：核对一遍、不是就切过去，不靠次序。
 */
async function ensureProjectA(page: Page) {
  const nameA = path.basename(projectA);
  const pill = page.getByTestId('project-pill');
  if (!(await pill.textContent())?.includes(nameA)) {
    await pill.click();
    await page.getByTestId(`project-item-${nameA}`).click();
    await expect(page.getByTestId('project-menu')).toBeHidden();
  }
  await expect(pill).toContainText(nameA);
}

/** 新建一个落在 projectA 的空对话，光标落进输入框。 */
async function freshComposerInA(page: Page) {
  await newThread(page);
  await ensureProjectA(page);
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
  // 胶囊与选单显示的是模型**名**（目录里的 `name`），不是 id —— 相邻两代的 id 只差一个
  // 版本号，光看 id 认不出谁是谁。id 仍然在选单行里，所以下面按 id 点得中。
  const pill = page.getByTestId('model-pill');
  await expect(pill).toContainText('Anthropic · Claude Sonnet 4.5');
  await pill.click();
  await page.getByText('▸ OpenAI').click();
  await page.locator('text=gpt-4o').first().click();
  await expect(pill).toContainText('OpenAI · GPT-4o');
});

test('27-composer: 翻上去看历史时，新输出不再把人拽回底部；「跳到最新」按了才回去', async () => {
  const { page } = launched;
  await freshComposer(page);
  await page.keyboard.type('跟随测试');
  await page.keyboard.press('Enter');
  const list = page.getByTestId('message-list');
  const scrollTop = () => list.evaluate((el) => el.scrollTop);
  const away = () => list.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);

  // 第一段落地、内容真的撑出了可滚动高度（不然下面「翻上去」无从谈起）
  await expect.poll(() => list.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 10000 })
    .toBeGreaterThan(400);
  // 钉在底部再开始：正文是异步长高的（markdown 渲染完才到最终高度），跟随那一步可能落在
  // 长高之前，位置未必就在底。这一条测的是「翻走之后」的行为，起点得先确定下来。
  await list.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(away).toBeLessThan(64);
  await expect(page.getByTestId('jump-to-latest')).toHaveCount(0);   // 贴底时按钮不在

  // 真的用滚轮往回翻（用户就是这么做的；程序赋值在位置本来就相同时连 scroll 事件都不发）
  await list.hover();
  await page.mouse.wheel(0, -1500);
  await expect(page.getByTestId('jump-to-latest')).toBeVisible();
  const parked = await scrollTop();
  expect(parked, '滚轮真的把位置挪上去了').toBeLessThan(600);

  // 后来的那一段（新的 text block）落地：位置一动不动 —— 这条就是「翻着翻着被弹回底部」的回归点
  await expect(list).toContainText('TAIL_MARKER', { timeout: 10000 });
  expect(await scrollTop(), '新输出不该动用户的位置').toBe(parked);

  // 点按钮才回到最新，按钮随之消失
  await page.getByTestId('jump-to-latest').click();
  await expect.poll(away).toBeLessThan(64);
  await expect(page.getByTestId('jump-to-latest')).toHaveCount(0);
});

test('附件：粘贴截图 → 托盘 → 发送 → agent 收到图片块 → 历史里缩略图真的解码了', async () => {
  const { page } = launched;
  const input = await freshComposer(page);
  await input.evaluate(async (el) => {
    const c = document.createElement('canvas'); c.width = 8; c.height = 6;
    const g = c.getContext('2d')!; g.fillStyle = '#336699'; g.fillRect(0, 0, 8, 6);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId('tray-item').filter({ hasText: '截图 1' })).toBeVisible();
  await input.click();
  await page.keyboard.type('看图');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await prompts()).find((p) => p.content.startsWith('看图'))).toMatchObject({
    images: [{ mimeType: 'image/png' }],
  });
  expect((await prompts()).find((p) => p.content.startsWith('看图'))!.content).toContain('<image n="1" name="截图 1"/>');
  const thumb = page.getByTestId('message-list').getByTestId('attachment-thumb').last();
  await expect.poll(() => thumb.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(8);
});

test('附件：回形针选文件 → 项目内发相对路径、项目外发绝对路径', async () => {
  const { page } = launched;
  await freshComposer(page);
  await page.getByTestId('composer-file-input').setInputFiles([path.join(projectA, 'refs', 'draft.pdf'), outsideFile]);
  await expect(page.getByTestId('tray-item').filter({ hasText: 'draft.pdf' })).toBeVisible();
  await expect(page.getByTestId('tray-item').filter({ hasText: 'outside.pdf' })).toBeVisible();
  await page.getByTestId('composer-input').click();
  await page.keyboard.type('看文件');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await prompts()).find((p) => p.content.startsWith('看文件'))?.content ?? '').toContain('<file path="refs/draft.pdf"/>');
  const sent = (await prompts()).find((p) => p.content.startsWith('看文件'))!.content;
  expect(sent).toContain(`<file path="${outsideFile.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"/>`);
});

test('@ 引用：打 @dpo（按名字找，往下读到 refs/）→ 列表里有它 → 回车成标签 → 发出的文字里是 kydog-ref', async () => {
  const { page } = launched;
  await freshComposerInA(page);
  await page.keyboard.type('对比 @dpo');
  const item = page.getByTestId('mention-item-refs/dpo-2023.pdf');
  await expect(item).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('composer-input').getByTestId('ref-chip')).toHaveText('dpo-2023.pdf');
  await page.keyboard.type('的表 2');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await prompts()).map((p) => p.content)).toContain('对比 <kydog-ref path="refs/dpo-2023.pdf"/> 的表 2');
});

test('@ 列表：Esc 关掉后不再弹回来、↵ 照常发送；没有匹配时不按 Esc、↵ 也直接发送', async () => {
  const { page } = launched;
  await freshComposer(page);
  const menu = page.getByTestId('mention-menu');
  await page.keyboard.type('看看@zzz');
  await expect(menu).toBeVisible();
  // 按名字找：整棵树读完之前显示「正在查找…」，读完仍没有才是「没有匹配的文件」。
  await expect(menu).toContainText('没有匹配的文件');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  // 「没弹回来」没有协议事实可等：回归的形态是松开 Esc 那一下 keyup 把同一个 @ 重新报上去，
  // 那是新的一次弹出、要等根目录的一趟 project.readDir 往返（毫秒级）才渲染出来 —— 只能留一小段观察窗再看一次。
  await page.waitForTimeout(300);
  await expect(menu).toBeHidden();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await prompts()).map((p) => p.content)).toContain('看看@zzz');

  // 不按 Esc：列表开着、查完且没有匹配时，↵ 不归列表管、照常发送（裁定 3 允许「谢谢@所有人」这种正文）。
  // 另起一个空对话：上一个对话这时可能还在跑那一轮，运行中不让发。
  await freshComposer(page);
  await page.keyboard.type('谢谢@所有人');
  await expect(menu).toContainText('没有匹配的文件');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await prompts()).map((p) => p.content)).toContain('谢谢@所有人');
});

test('@ 列表：打 @re → 文件夹 refs 排第一 → ↵ 进入下一层（输入框里变成 @refs/，不插标签）→ 首行是文件夹本身、默认高亮 → ↓ 到子项再 ↵ 才插那个文件', async () => {
  const { page } = launched;
  const input = await freshComposerInA(page);
  await page.keyboard.type('@re');
  // 根这一层的 refs（文件夹）、README.md、Related Work 都以 re 开头：同档、同深度，路径最短的 refs 在前 —— 高亮默认在第一项。
  // （Empty Dir 不中：r 后面没有 e。）
  const menu = page.getByTestId('mention-menu');
  await expect(page.getByTestId('mention-dir-refs')).toBeVisible();
  await expect(menu.locator('button').first()).toHaveAttribute('data-testid', 'mention-dir-refs');
  await expect(menu.getByTestId('mention-dir-refs')).toContainText('refs/');

  await page.keyboard.press('Enter');
  await expect.poll(() => readBodyText(page)).toBe('@refs/');
  await expect(page.getByTestId('mention-item-refs/dpo-2023.pdf')).toBeVisible();
  await expect(page.getByTestId('mention-item-refs/draft.pdf')).toBeVisible();
  const chips = input.getByTestId('ref-chip');
  // 选中文件夹是进入、不插标签（正向见下面：同一个输入框里选中文件就插出来了）
  await expect(chips).toHaveCount(0);

  // 进来之后首行是 refs 本身、高亮在它上面；↓ 挪到第一个子项（readDir 的次序：dpo-2023.pdf 在 draft.pdf 前）
  const selfRow = page.getByTestId('mention-self-refs');
  await expect(menu.locator('button').first()).toHaveAttribute('data-testid', 'mention-self-refs');
  await expect(selfRow).toContainText('引用整个文件夹');
  await expect(selfRow).toHaveAttribute('data-highlighted', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('mention-item-refs/dpo-2023.pdf')).toHaveAttribute('data-highlighted', 'true');
  await expect(selfRow).toHaveAttribute('data-highlighted', 'false');
  await page.keyboard.press('Enter');
  await expect(chips).toHaveCount(1);
  await expect(chips).toHaveText('dpo-2023.pdf');
  await expect(chips).toHaveAttribute('title', 'refs/dpo-2023.pdf');
  await expect(menu).toBeHidden();
});

test('@ 列表：名字里有空格的文件夹 → ↵ 写成两侧引号 @"Related Work/"、光标停在收尾引号前 → 接着打的字落在引号里并筛选 → ↵ 成标签（两侧引号一起换掉）→ 发出的文字里是 kydog-ref', async () => {
  const { page } = launched;
  const input = await freshComposerInA(page);
  await page.keyboard.type('看 @Rel');
  // 根这一层以 rel 开头的只有 Related Work（README.md / refs / Empty Dir 里都没有这个子序列），更深处也没有文件名命中 rel
  const menu = page.getByTestId('mention-menu');
  await expect(page.getByTestId('mention-dir-Related Work')).toBeVisible();
  await expect(menu.locator('button').first()).toHaveAttribute('data-testid', 'mention-dir-Related Work');

  await page.keyboard.press('Enter');
  // 不带引号的话 @ 词在空格处就断了，列表当场关掉、正文里留下一截死字
  await expect.poll(() => readBodyText(page)).toBe('看 @"Related Work/"');
  const survey = page.getByTestId('mention-item-Related Work/survey.md');
  const notes = page.getByTestId('mention-item-Related Work/notes.md');
  await expect(survey).toBeVisible();
  await expect(notes).toBeVisible();
  await expect(page.getByTestId('mention-self-Related Work')).toBeVisible();

  // 光标停在收尾引号前：打的字落在引号里，列表按它筛（notes.md 上面在，这里被筛掉）
  await page.keyboard.type('su');
  await expect.poll(() => readBodyText(page)).toBe('看 @"Related Work/su"');
  await expect(survey).toBeVisible();
  await expect(notes).toBeHidden();

  // 光标移到收尾引号之后：不再是 @ 词，列表关掉；移回引号里又开
  await page.keyboard.press('ArrowRight');
  await expect(menu).toBeHidden();
  await page.keyboard.press('ArrowLeft');
  await expect(survey).toBeVisible();

  await page.keyboard.press('Enter');
  const chips = input.getByTestId('ref-chip');
  await expect(chips).toHaveCount(1);
  await expect(chips).toHaveAttribute('title', 'Related Work/survey.md');
  await expect(menu).toBeHidden();
  // 整段 @"…" 连两侧引号一起换成了标签：正文里一个引号都不剩（上面几步里它确实带着引号）
  expect(await readBodyText(page)).not.toContain('"');
  await page.keyboard.type('的结论');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await prompts()).map((p) => p.content)).toContain('看 <kydog-ref path="Related Work/survey.md"/> 的结论');
});

test('@ 列表：进入一个空文件夹 → 只有「文件夹本身」那一行（不出「没有匹配的文件」）→ ↵ 插成文件夹标签 Empty Dir/ → 发出的文字里是 kydog-ref path="Empty Dir/"', async () => {
  const { page } = launched;
  const input = await freshComposerInA(page);
  await page.keyboard.type('看 @Emp');
  // 根这一层以 emp 开头的只有 Empty Dir；README.md 等名字里没有 e→m→p 这个子序列
  const menu = page.getByTestId('mention-menu');
  await expect(page.getByTestId('mention-dir-Empty Dir')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(() => readBodyText(page)).toBe('看 @"Empty Dir/"');
  const selfRow = page.getByTestId('mention-self-Empty Dir');
  await expect(selfRow).toBeVisible();
  await expect(selfRow).toContainText('Empty Dir/');
  await expect(selfRow).toContainText('引用整个文件夹');
  await expect(selfRow).toHaveAttribute('data-highlighted', 'true');

  // 状态行确实出得来：在 / 之后打一个筛选词（这一层里没有东西能中）→「没有匹配的文件」，文件夹本身那一行不在
  await page.keyboard.type('zz');
  await expect.poll(() => readBodyText(page)).toBe('看 @"Empty Dir/zz"');
  await expect(menu).toContainText('没有匹配的文件');
  await expect(selfRow).toBeHidden();
  // 删掉筛选词：回到文件夹本身那一行，没有状态行
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expect.poll(() => readBodyText(page)).toBe('看 @"Empty Dir/"');
  await expect(selfRow).toBeVisible();
  await expect(menu).not.toContainText('没有匹配的文件');

  await page.keyboard.press('Enter');
  const chips = input.getByTestId('ref-chip');
  await expect(chips).toHaveCount(1);
  await expect(chips).toHaveAttribute('data-ref-path', 'Empty Dir/');
  await expect(chips).toHaveAttribute('title', 'Empty Dir/');
  await expect(chips).toHaveText('Empty Dir/');
  await expect(menu).toBeHidden();
  await page.keyboard.type('里有什么');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await prompts()).map((p) => p.content)).toContain('看 <kydog-ref path="Empty Dir/"/> 里有什么');
});

test('md 评论：选区工具栏 → 批注框 → ⌘↵ → 标签计数 → 输入框里的卡片 → 发出去；再走一遍评论模式', async () => {
  const { page } = launched;
  const threadId = await newThread(page);
  // 这条要的是 projectA（ch3.md 在那里）。
  await ensureProjectA(page);

  const mdPath = path.join(projectA, 'ch3.md');
  await page.getByTestId(`fs-${mdPath}`).dblclick();
  const editor = page.locator('.kydog-md-editor .ProseMirror').locator('visible=true');
  await editor.waitFor();
  const selectText = (text: string) => editor.evaluate((root, needle) => {
    (root as HTMLElement).focus();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent!.indexOf(needle);
      if (i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + needle.length);
      const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
      return;
    }
    throw new Error(`not found: ${needle}`);
  }, text);

  // 入口一：选区工具栏
  await selectText('将 β 固定为 0.1');
  const toolbar = page.locator('.milkdown-toolbar').locator('visible=true');
  await expect(toolbar).toBeVisible();

  // Issue 1：hover 提示。最后一颗是 KyDog 加的评论键（tooltip 就叫「评论」，功能整体
  // 叫「评论追问」但按钮的 tip 不带「追问」二字）；第一颗是 Crepe 内置的加粗——按快捷键
  // 文案区分平台，这里只断言前缀，不锁死 ⌘/Ctrl 那半截。
  const lastItem = toolbar.locator('.toolbar-item').last();
  await lastItem.hover();
  const lastTip = lastItem.locator('.kydog-tb-tip');
  await expect(lastTip).toBeVisible();
  await expect(lastTip).toHaveText('评论');

  const firstItem = toolbar.locator('.toolbar-item').first();
  await firstItem.hover();
  const firstTip = firstItem.locator('.kydog-tb-tip');
  await expect(firstTip).toBeVisible();
  await expect(firstTip).toHaveText(/^加粗/);

  // Issue 2：评论图标不再被 Crepe「实心字形」那条 `.toolbar-item svg { fill: … }` 规则
  // 整块染色——每个 path 自己 fill="none"，计算样式也该是 none（正向：反正 svg 本身的
  // fill 不是 none，这里断言的是 path 层面被单独盖掉，不是巧合撞对了默认值）。
  const commentPaths = lastItem.locator('svg path');
  await expect(commentPaths).toHaveCount(3);
  const pathFills = await commentPaths.evaluateAll((els) => els.map((el) => getComputedStyle(el).fill));
  expect(pathFills.every((f) => f === 'none')).toBe(true);

  await toolbar.locator('.toolbar-item').last().dispatchEvent('pointerdown');
  await expect(page.getByTestId('comment-box')).toBeVisible();
  // 用真实按键而不是 locator.fill()：fill() 会直接 focus 目标元素，会掩盖掉「批注框没抢到
  // 焦点、打字漏进 ProseMirror 把选中的原文吃掉」这一类真实 bug —— 只有键盘事件才如实反映
  // 焦点到底落在哪。
  await page.keyboard.type('取值依据？');
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('comment-box-input');
  await expect(page.getByTestId('comment-box-input')).toHaveValue('取值依据？');
  await expect(editor).toContainText('将 β 固定为 0.1'); // 正向：选中的原文没被打字吃掉
  // 写到一半切去对话再切回来：框是挂在 body 上的 fixed portal，md 标签被 display:none 藏起来时它得
  // 跟着不渲染，不能浮在对话上（上面 toBeVisible 是它在的正向证明）；切回来原样出现，写了一半的字还在。
  await page.getByTestId(`tab-${threadId}`).click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByTestId('comment-box')).toHaveCount(0);
  await page.getByTestId(`tab-${mdPath}`).click();
  await expect(page.getByTestId('comment-box')).toBeVisible();
  await expect(page.getByTestId('comment-box-input')).toHaveValue('取值依据？');
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('comment-box-input');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('comment-box')).toHaveCount(0);
  await expect(page.getByTestId(`tab-badge-${threadId}`)).toHaveText('1');
  await expect(editor.locator('.kydog-comment-mark')).toHaveText('将 β 固定为 0.1');

  // 入口二：评论模式 —— 选中即弹框，选区工具栏不出
  // Issue 3：开着的胶囊要比默认淡背景更显眼（accent 强调色）。先记下关着时的计算背景，
  // 开着后再比——同一条用例里翻一遍面，不能只断言其中一态（CLAUDE.md 否定断言的要求）。
  const capsuleToggle = page.getByTestId('md-comment-mode');
  const capsuleBgOff = await capsuleToggle.evaluate((el) => getComputedStyle(el).backgroundColor);
  await capsuleToggle.click();
  await expect(page.getByTestId('md-capsule')).toHaveAttribute('data-comment-mode', 'on');
  const capsuleBgOn = await capsuleToggle.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(capsuleBgOn).not.toBe('transparent');
  expect(capsuleBgOn).not.toBe('rgba(0, 0, 0, 0)'); // 浏览器把 CSS transparent 算出来的计算值
  expect(capsuleBgOn).not.toBe(capsuleBgOff);
  await selectText('并复现');
  // selectText 只改 DOM selection；ProseMirror 要等异步的 selectionchange 才会把它同步进
  // view.state.selection。等 Crepe 工具栏的 tooltip 插件打上 data-show="true"（选区非空 +
  // 有焦点，节流约 200ms 后才打；评论模式下这个元素被 CSS 藏起来，但插件照样会打这个标记）
  // 就是「ProseMirror 已经看到这个非空选区」的协议事实，不能一 selectText 完就立刻派发 mouseup。
  await expect(page.locator('.milkdown-toolbar[data-show="true"]')).toHaveCount(1);
  await editor.dispatchEvent('mouseup');
  await expect(page.getByTestId('comment-box')).toBeVisible(); // 正向证明：这一下确实弹出过框
  await expect(page.locator('.milkdown-toolbar').locator('visible=true')).toHaveCount(0);
  await page.keyboard.press('Escape'); // 取消批注框
  await expect(page.getByTestId('comment-box')).toHaveCount(0);
  // 退出评论模式改用点胶囊，不用第二下 Esc：点胶囊这一下也会在包裹层上冒泡出 mouseup，
  // 而 commentMode 这时还没来得及切掉（onClick 排在 onMouseUp 之后才跑）——这条用例守的
  // 正是「点胶囊退出不会把这次 mouseup 误判成又选中了一段新文字、重新弹框」
  // （MarkdownFileTab.tsx「发现 3」，bec3aa6 修的那个 bug）。取消框会把选区收拢成空的，
  // 光点胶囊测不出这个 bug——空选区不管来源过滤在不在都不会弹框。重新选一段非空的文字，
  // 但不派发 mouseup（那样才是「合法」触发的路径），再去点胶囊，才是这条判断真正要守的场景。
  await selectText('并复现');
  // 同上：等 ProseMirror 真的同步到这个非空选区，再去点胶囊——否则点的时候 view.state.selection
  // 可能还是上一次（或空的），这条判断就测不出「点胶囊会不会误开新框」。
  await expect(page.locator('.milkdown-toolbar[data-show="true"]')).toHaveCount(1);
  await page.getByTestId('md-comment-mode').click();
  await expect(page.getByTestId('md-capsule')).toHaveAttribute('data-comment-mode', 'off');
  // 如果来源过滤丢了，误触发的 openBoxFromSelection 是从 mouseup 里的 setTimeout(…, 0) 异步
  // 弹出的——这里没有协议事实可等，只能等一小段观察窗，确认点完之后确实什么都没发生。
  await page.waitForTimeout(150);
  await expect(page.getByTestId('comment-box')).toHaveCount(0);

  // Esc 退出评论模式（没有框开着时的那条路径）：再进一次模式，这次直接按 Esc，不经过批注框。
  await page.getByTestId('md-comment-mode').click();
  await expect(page.getByTestId('md-capsule')).toHaveAttribute('data-comment-mode', 'on');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('md-capsule')).toHaveAttribute('data-comment-mode', 'off');

  // 回到对话：卡片在；发出去
  await page.getByTestId(`tab-${threadId}`).click();
  await expect(page.getByTestId('composer-comment-card')).toHaveCount(1);
  await page.getByTestId('composer-input').click();
  await page.keyboard.type('整理批注');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await prompts()).find((p) => p.content.startsWith('整理批注'))?.content ?? '').toContain('<quote>将 β 固定为 0.1</quote>');
  const sent = (await prompts()).find((p) => p.content.startsWith('整理批注'))!.content;
  expect(sent).toMatch(/<kydog-comment file="[^"]*ch3\.md" section="3\.2 偏好对齐">/);
  await expect(page.getByTestId('message-list').getByTestId('user-comment-card')).toHaveCount(1);
  await expect(page.getByTestId(`tab-badge-${threadId}`)).toHaveCount(0);
  // 收尾：关掉 md tab，后面的用例（21-skills-page）从干净的 tab 条开始。
  await page.getByTestId(`tab-close-${mdPath}`).click();
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
