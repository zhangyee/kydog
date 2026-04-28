import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings } from './helpers';

test('09-collapse: workspace and inspector each toggle independently', async () => {
  const launched = await launchKydog({ seed: seedSettings });
  try {
    const ws = launched.page.locator('[data-pane="workspace"]');
    const ins = launched.page.locator('[data-pane="inspector"]');
    const initialWs = await ws.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
    const initialIns = await ins.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
    expect(initialWs).toBeGreaterThan(100);
    expect(initialIns).toBeGreaterThan(100);

    await launched.page.locator('[data-testid="collapse-workspace"]').click();
    await expect.poll(() => ws.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width)).toBeLessThan(40);

    await launched.page.locator('[data-testid="collapse-inspector"]').click();
    await expect.poll(() => ins.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width)).toBeLessThan(40);
  } finally {
    await teardown(launched);
  }
});
