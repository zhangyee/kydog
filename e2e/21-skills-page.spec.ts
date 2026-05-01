import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, teardown } from './helpers';

test('21-skills-page: toggle built-in fastpaper persists to settings file', async () => {
  const launched = await launchKydog({
    seed: async (home) => { await seedSettings(home); },
  });
  try {
    await launched.page.click('[data-testid=nav-skills]');
    await launched.page.locator('text=fastpaper').first().waitFor();
    await launched.page.locator('[role=switch][aria-checked=true]').first().click();
    await expect(launched.page.locator('text=已禁用').first()).toBeVisible();

    const settingsRaw = await fs.readFile(
      path.join(launched.kydogHome, '.kydog', 'kydog.json'),
      'utf8',
    );
    const settings = JSON.parse(settingsRaw) as { skills: { disabledBuiltins: string[] } };
    expect(settings.skills.disabledBuiltins).toContain('fastpaper');
  } finally {
    await teardown(launched);
  }
});
