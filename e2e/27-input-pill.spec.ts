import { test, expect } from '@playwright/test';
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

test('27-input-pill: Shift+Enter inserts newline, Enter clears textarea (send fires)', async () => {
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
    await input.fill('hello');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('world');
    await expect(input).toHaveValue('hello\nworld');

    await input.fill('ping');
    await page.keyboard.press('Enter');
    // Textarea is cleared optimistically before the IPC call, regardless of whether the LLM responds.
    await expect(input).toHaveValue('');
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
    // Builtin `fastpaper` skill is auto-installed at first run (see 19-skill-sync.spec.ts).
    await expect(page.locator('[data-testid="slash-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="slash-item-fastpaper"]')).toBeVisible();
    // The two-column popover also surfaces the highlighted item's description.
    await expect(page.locator('[data-testid="slash-menu-desc"]')).toBeVisible();
    await page.keyboard.press('Enter');
    // After commit: the chip is rendered inline; the textarea body is empty.
    await expect(page.locator('[data-testid="skill-chip"]')).toContainText('fastpaper');
    await expect(input).toHaveValue('');
    await expect(page.locator('[data-testid="slash-menu"]')).toBeHidden();
  } finally {
    await teardown(launched);
  }
});

test('27-input-pill: backspace at body[0] removes the chip; body text is preserved', async () => {
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

    // Type some body text after the chip.
    await page.keyboard.type('hello world');
    await expect(input).toHaveValue('hello world');

    // Move caret to position 0, then backspace → chip removed, body preserved.
    await page.keyboard.press('Home');
    await page.keyboard.press('Backspace');
    await expect(page.locator('[data-testid="skill-chip"]')).toHaveCount(0);
    await expect(input).toHaveValue('hello world');
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
    // Open new thread (default to first project = projectA).
    await page.locator('[data-testid="new-thread"]').click();
    const projectPill = page.locator('[data-testid="project-pill"]');
    await expect(projectPill).toContainText(projectAName);

    await projectPill.click();
    await expect(page.locator('[data-testid="project-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="project-item-current"]')).toContainText(projectAName);

    const otherItem = page.locator(`[data-testid="project-item-${projectBName}"]`);
    await expect(otherItem).toBeVisible();
    await otherItem.click();

    // Menu closes; pill reflects the new project.
    await expect(page.locator('[data-testid="project-menu"]')).toBeHidden();
    await expect(projectPill).toContainText(projectBName);
  } finally {
    await teardown(launched);
  }
});
