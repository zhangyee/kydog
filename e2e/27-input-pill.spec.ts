import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { launchKydog, teardown, seedSettings, seedProject, seedSamplePackage } from './helpers';

async function seedTwoProjects(kydogHome: string, projectA: string, projectB: string) {
  await fs.mkdir(path.join(kydogHome, '.kydog'), { recursive: true });
  await fs.writeFile(
    path.join(kydogHome, '.kydog', 'index.json'),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: projectA, addedAt: new Date().toISOString() },
        { path: projectB, addedAt: new Date().toISOString() },
      ],
      threads: [],
    }, null, 2),
  );
}

/**
 * Read the editor's "body" text, i.e. all text in the contenteditable EXCEPT
 * the leading skill chip element. Mirrors the parseEditor logic in
 * InputPillEditor.tsx.
 */
async function readBodyText(page: Page): Promise<string> {
  return await page.locator('[data-testid="input-pill"]').evaluate((el: HTMLElement) => {
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

test('27-input-pill: Shift+Enter inserts newline, Enter clears editor (send fires)', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const launched = await launchKydog({
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
  const { page } = launched;
  try {
    await page.locator('[data-testid="new-thread"]').click();
    const input = page.locator('[data-testid="input-pill"]');
    await input.click();
    await page.keyboard.type('hello');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('world');
    expect(await readBodyText(page)).toBe('hello\nworld');

    await input.click();
    // Select all + replace with "ping" to reset.
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('ping');
    await page.keyboard.press('Enter');
    // Editor is cleared optimistically before the IPC call.
    expect(await readBodyText(page)).toBe('');
  } finally {
    await teardown(launched);
  }
});

test('27-input-pill: typing / opens slash menu with description; Enter commits as chip', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const launched = await launchKydog({
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
  const { page } = launched;
  try {
    await page.locator('[data-testid="new-thread"]').click();
    const input = page.locator('[data-testid="input-pill"]');
    await input.click();
    await page.keyboard.type('/');
    // Builtin `fastpaper` skill is auto-installed at first run.
    await expect(page.locator('[data-testid="slash-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="slash-item-fastpaper"]')).toBeVisible();
    await expect(page.locator('[data-testid="slash-menu-desc"]')).toBeVisible();
    await page.keyboard.press('Enter');
    // After commit: the chip is rendered inline; the body is empty.
    await expect(page.locator('[data-testid="skill-chip"]')).toContainText('fastpaper');
    expect(await readBodyText(page)).toBe('');
    await expect(page.locator('[data-testid="slash-menu"]')).toBeHidden();
  } finally {
    await teardown(launched);
  }
});

test('27-input-pill: × button removes chip without losing existing body text', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const launched = await launchKydog({
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
  const { page } = launched;
  try {
    await page.locator('[data-testid="new-thread"]').click();
    const input = page.locator('[data-testid="input-pill"]');
    await input.click();
    await page.keyboard.type('/');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="skill-chip"]')).toBeVisible();

    // Type body content AFTER the chip exists.
    await page.keyboard.type('hello world');
    expect(await readBodyText(page)).toBe('hello world');

    // Hover the chip to reveal × (we just click directly — the button is present in DOM, opacity is fine for click).
    await page.locator('[data-testid="skill-chip-remove"]').click();

    await expect(page.locator('[data-testid="skill-chip"]')).toHaveCount(0);
    // Body text MUST survive the × click.
    expect(await readBodyText(page)).toBe('hello world');
  } finally {
    await teardown(launched);
  }
});

test('27-input-pill: committing a slash command preserves trailing body text', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const launched = await launchKydog({
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
  const { page } = launched;
  try {
    await page.locator('[data-testid="new-thread"]').click();
    const input = page.locator('[data-testid="input-pill"]');
    await input.click();
    // Type "/fast extra args" — slash + filter token + trailing args.
    await page.keyboard.type('/fast extra args');
    await expect(page.locator('[data-testid="slash-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="slash-item-fastpaper"]')).toBeVisible();
    await page.keyboard.press('Enter');

    // Chip = fastpaper, body keeps "extra args" (stripped only the "/fast " prefix).
    await expect(page.locator('[data-testid="skill-chip"]')).toContainText('fastpaper');
    expect(await readBodyText(page)).toBe('extra args');
  } finally {
    await teardown(launched);
  }
});

test('27-input-pill: backspace immediately after chip removes the chip; body preserved', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const launched = await launchKydog({
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
  const { page } = launched;
  try {
    await page.locator('[data-testid="new-thread"]').click();
    const input = page.locator('[data-testid="input-pill"]');
    await input.click();
    await page.keyboard.type('/');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="skill-chip"]')).toBeVisible();

    // Type body text after the chip.
    await page.keyboard.type('hello world');
    expect(await readBodyText(page)).toBe('hello world');

    // Place caret at start of the body text node (right after the chip).
    await input.evaluate((el: HTMLElement) => {
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          const range = document.createRange();
          range.setStart(node, 0);
          range.collapse(true);
          const sel = window.getSelection();
          if (sel) { sel.removeAllRanges(); sel.addRange(range); }
          return;
        }
      }
    });
    await page.keyboard.press('Backspace');
    await expect(page.locator('[data-testid="skill-chip"]')).toHaveCount(0);
    expect(await readBodyText(page)).toBe('hello world');
  } finally {
    await teardown(launched);
  }
});

test('27-input-pill: slash menu reopens after chip removal even when body has leading whitespace', async () => {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-'));
  await seedSamplePackage(projectPath);
  const launched = await launchKydog({
    seed: async (home) => { await seedSettings(home); await seedProject(home, projectPath); },
  });
  const { page } = launched;
  try {
    await page.locator('[data-testid="new-thread"]').click();
    const input = page.locator('[data-testid="input-pill"]');
    await input.click();
    // Type body text directly (no chip).
    await page.keyboard.type('测试');
    // Position cursor at the very start, then prefix " " then "/".
    await input.evaluate((el: HTMLElement) => {
      const firstText = Array.from(el.childNodes).find((n) => n.nodeType === Node.TEXT_NODE);
      if (!firstText) return;
      const range = document.createRange();
      range.setStart(firstText, 0);
      range.collapse(true);
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    });
    await page.keyboard.type('/');
    // Body is now "/测试" with the slash at position 0 → menu opens, filtering by "测试" yields nothing → menu closed.
    // Type a space to make it "/ 测试" → token is empty → all skills visible.
    await page.keyboard.type(' ');
    await expect(page.locator('[data-testid="slash-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="slash-item-fastpaper"]')).toBeVisible();
  } finally {
    await teardown(launched);
  }
});

test('27-input-pill: project pill switches the empty thread to another project', async () => {
  const projectA = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-a-'));
  const projectB = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-proj-b-'));
  await seedSamplePackage(projectA);
  await seedSamplePackage(projectB);
  const projectAName = path.basename(projectA);
  const projectBName = path.basename(projectB);

  const launched = await launchKydog({
    seed: async (home) => {
      await seedSettings(home);
      await seedTwoProjects(home, projectA, projectB);
    },
  });
  const { page } = launched;
  try {
    await page.locator('[data-testid="new-thread"]').click();
    const projectPill = page.locator('[data-testid="project-pill"]');
    await expect(projectPill).toContainText(projectAName);

    await projectPill.click();
    await expect(page.locator('[data-testid="project-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="project-item-current"]')).toContainText(projectAName);

    const otherItem = page.locator(`[data-testid="project-item-${projectBName}"]`);
    await expect(otherItem).toBeVisible();
    await otherItem.click();

    await expect(page.locator('[data-testid="project-menu"]')).toBeHidden();
    await expect(projectPill).toContainText(projectBName);
  } finally {
    await teardown(launched);
  }
});
