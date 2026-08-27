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

    // manifest 只记「装过哪些内置 skill」的名字列表，逐文件的 sha 账本已随两方比对一并删掉：
    // 磁盘现状随时能算，跨启动需要记住的只有这份名字（孤儿清理靠它）。
    const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf-8'));
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.builtin).toContain('fastpaper');
    expect(manifest.kydogVersion).toBeTruthy();
  } finally {
    await teardown(launched);
  }
});
