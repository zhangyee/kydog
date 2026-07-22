import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, teardown, seedProject, seedSamplePackage } from './helpers';

async function seedTwoProviders(kydogHome: string) {
  const v2 = {
    schemaVersion: 2 as const,
    ui: { theme: 'vellum', locale: 'zh', workspaceCollapsed: false, inspectorCollapsed: false },
    llm: {
      auth: {
        anthropic: { type: 'api_key', key: 'sk-fix-1' },
        openai: { type: 'api_key', key: 'sk-fix-2' },
      },
      providers: {
        anthropic: { defaultModel: 'claude-sonnet-4-5' },
        openai: { defaultModel: 'gpt-4o' },
      },
      customProviders: [],
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-4-5',
    },
    skills: { disabledBuiltins: [] },
    tools: { externalBins: [] },
    onboarding: { completedAt: '2026-01-01T00:00:00.000Z' },
  };
  await fs.mkdir(path.join(kydogHome, '.kydog'), { recursive: true });
  await fs.writeFile(path.join(kydogHome, '.kydog', 'kydog.json'), JSON.stringify(v2, null, 2));
}

test('24-llm: in-session thread override switches Composer label', async () => {
  const projectPath = await fs.mkdtemp(path.join(process.env.TMPDIR || '/tmp', 'kydog-proj-'));
  await seedSamplePackage(projectPath);

  const launched = await launchKydog({
    seed: async (h) => {
      await seedTwoProviders(h);
      await seedProject(h, projectPath, [{ id: 't-24', title: '24-test' }]);
    },
  });
  const { page } = launched;
  try {
    await page.getByText('24-test').first().click();
    await expect(page.locator('text=/Anthropic · /')).toBeVisible({ timeout: 5000 });

    // Click pill → menu opens. Click OpenAI summary to expand, then click gpt-4o.
    await page.locator('text=/Anthropic · /').click();
    await page.getByText('▸ OpenAI').click();
    await page.locator('text=gpt-4o').first().click();

    // Pill flips to OpenAI · gpt-4o + ⓘ override marker.
    await expect(page.locator('text=/OpenAI · gpt-4o/')).toBeVisible();
  } finally {
    await teardown(launched);
  }
});
