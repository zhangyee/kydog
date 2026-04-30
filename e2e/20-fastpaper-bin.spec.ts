import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings } from './helpers';

test('20-fastpaper-bin: PATH head is the bundled fastpaper directory', async () => {
  const launched = await launchKydog({
    seed: async (home) => { await seedSettings(home); },
  });
  try {
    const main = await launched.app.evaluate(({ app }) => {
      const sep = process.platform === 'win32' ? ';' : ':';
      return {
        isPackaged: app.isPackaged,
        pathHead: process.env.PATH?.split(sep)[0],
        resourcesPath: process.resourcesPath,
      };
    });
    if (main.isPackaged) {
      expect(main.pathHead).toBe(main.resourcesPath);
    } else {
      expect(main.pathHead).toMatch(/[\\/]vendor[\\/]current$/);
    }
  } finally {
    await teardown(launched);
  }
});
