import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings } from './helpers';

test('25-llm: save Bedrock IAM keys → main process.env reflects', async () => {
  const launched = await launchKydog({
    seed: (home) => seedSettings(home, { providerConfigured: false }),
    env: { KYDOG_E2E: '1' },
  });
  const { page, app } = launched;
  try {
    await expect(page.getByText('还未配置任何 provider')).toBeVisible();
    await page.getByRole('button', { name: '+ 添加 provider' }).click();
    await page.getByText('Amazon Bedrock', { exact: true }).click();

    // CloudForm Bedrock branch: select IAM Keys, fill access/secret/region.
    await page.getByLabel('iamKeys').check();
    await page.getByPlaceholder('AKIA…').fill('AKIATEST');
    await page.locator('input[type="password"]').first().fill('secrettest');
    await page.getByPlaceholder('us-east-1').fill('us-east-1');
    await page.getByRole('button', { name: '保存' }).click();
    await page.waitForTimeout(500);

    // Verify process.env via app.evaluate (runs in main process).
    const snap = await app.evaluate(async () => ({
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? null,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? null,
      AWS_REGION: process.env.AWS_REGION ?? null,
    }));
    expect(snap.AWS_ACCESS_KEY_ID).toBe('AKIATEST');
    expect(snap.AWS_SECRET_ACCESS_KEY).toBe('secrettest');
    expect(snap.AWS_REGION).toBe('us-east-1');
  } finally {
    await teardown(launched);
  }
});
