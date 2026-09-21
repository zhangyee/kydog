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
 * 附件与评论四条互不依赖，都从 `newThread` 起；md 评论那条会开一个文件 tab，结束时关掉。
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

/** 剧本形状照 `ping`：agent_start → 一段文字 → agent_end。新增四条只是回复文字不同。 */
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
      '整理批注': reply('整理完了'),
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

test('@ 引用：打 @dpo → 列表里有它 → 回车成标签 → 发出的文字里是 kydog-ref', async () => {
  const { page } = launched;
  await freshComposer(page);
  await page.keyboard.type('对比 @dpo');
  const item = page.getByTestId('mention-item-refs/dpo-2023.pdf');
  await expect(item).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('composer-input').getByTestId('ref-chip')).toHaveText('dpo-2023.pdf');
  await page.keyboard.type('的表 2');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await prompts()).map((p) => p.content)).toContain('对比 <kydog-ref path="refs/dpo-2023.pdf"/> 的表 2');
});

test('md 评论：选区工具栏 → 批注框 → ⌘↵ → 标签计数 → 输入框里的卡片 → 发出去；再走一遍评论模式', async () => {
  const { page } = launched;
  const threadId = await newThread(page);
  // `27-composer: project pill switches...` 那条把一个空对话切去过 projectB；「新对话」按钮
  // 本身固定拿 projects[0]（projectA），理论上不受影响，但核对一遍再切回去，不靠这个假设。
  const nameA = path.basename(projectA);
  const pill = page.getByTestId('project-pill');
  if (!(await pill.textContent())?.includes(nameA)) {
    await pill.click();
    await page.getByTestId(`project-item-${nameA}`).click();
    await expect(page.getByTestId('project-menu')).toBeHidden();
  }
  await expect(pill).toContainText(nameA);

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
  await toolbar.locator('.toolbar-item').last().dispatchEvent('pointerdown');
  await expect(page.getByTestId('comment-box')).toBeVisible();
  // 用真实按键而不是 locator.fill()：fill() 会直接 focus 目标元素，会掩盖掉「批注框没抢到
  // 焦点、打字漏进 ProseMirror 把选中的原文吃掉」这一类真实 bug —— 只有键盘事件才如实反映
  // 焦点到底落在哪。
  await page.keyboard.type('取值依据？');
  await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('comment-box-input');
  await expect(page.getByTestId('comment-box-input')).toHaveValue('取值依据？');
  await expect(editor).toContainText('将 β 固定为 0.1'); // 正向：选中的原文没被打字吃掉
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByTestId('comment-box')).toHaveCount(0);
  await expect(page.getByTestId(`tab-badge-${threadId}`)).toHaveText('1');
  await expect(editor.locator('.kydog-comment-mark')).toHaveText('将 β 固定为 0.1');

  // 入口二：评论模式 —— 选中即弹框，选区工具栏不出
  await page.getByTestId('md-comment-mode').click();
  await expect(page.getByTestId('md-capsule')).toHaveAttribute('data-comment-mode', 'on');
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
