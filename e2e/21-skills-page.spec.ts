import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, teardown } from './helpers';

test('21-skills-page: toggling a built-in skill off persists to settings file', async () => {
  const launched = await launchKydog({
    seed: async (home) => { await seedSettings(home); },
  });
  try {
    await launched.page.click('[data-testid=nav-skills]');
    // 从 DOM 读出被点的是哪个 skill，别假定内置 skill 的字母序：
    // listBuiltinSkills 按目录名排序，加一个字母序更靠前的 skill 就会换位。
    const enabledRow = launched.page
      .locator('[data-testid=skill-row]')
      .filter({ has: launched.page.locator('[role=switch][aria-checked=true]') })
      .first();
    await enabledRow.waitFor();
    const name = await enabledRow.getAttribute('data-skill-name');
    expect(name).toBeTruthy();

    // 换成按名字定位：上面那个 locator 带「开关是开着的」条件，点完就不再匹配这一行了。
    const row = launched.page.locator(`[data-testid=skill-row][data-skill-name="${name}"]`);
    await row.locator('[role=switch]').click();
    await expect(row.locator('text=已禁用')).toBeVisible();

    const settingsRaw = await fs.readFile(
      path.join(launched.kydogHome, '.kydog', 'kydog.json'),
      'utf8',
    );
    const settings = JSON.parse(settingsRaw) as { skills: { disabledBuiltins: string[] } };
    expect(settings.skills.disabledBuiltins).toContain(name);
  } finally {
    await teardown(launched);
  }
});
