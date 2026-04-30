import { test, expect } from '@playwright/test';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { launchKydog, teardown, seedSettings } from './helpers';

test('19-skill-sync: first run installs builtin fastpaper skill into <HOME>/.kydog/skills/', async () => {
  const launched = await launchKydog({
    seed: async (home) => { await seedSettings(home); },
  });
  try {
    const skillsDir = path.join(launched.kydogHome, '.kydog', 'skills');
    const skillFile = path.join(skillsDir, 'fastpaper', 'SKILL.md');
    const manifestFile = path.join(skillsDir, '.manifest.json');

    await expect.poll(
      async () => fs.access(skillFile).then(() => true).catch(() => false),
      { timeout: 5_000 },
    ).toBe(true);

    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf-8'));
    expect(manifest.builtin?.fastpaper?.files?.['SKILL.md']).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.kydogVersion).toBeTruthy();
  } finally {
    await teardown(launched);
  }
});
