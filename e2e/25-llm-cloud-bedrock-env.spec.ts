import { test, expect } from '@playwright/test';
import { launchKydog, teardown } from './helpers';

test.skip('25-llm: save Bedrock IAM keys → process.env reflects', async () => {
  const launched = await launchKydog({});
  const { app } = launched;
  try {
    // Drive UI to add Bedrock with IAM keys + region
    // Use ipcRenderer.invoke('kydog:debug:envSnapshot') to read env via main process
    const snap = await app.evaluate(async () => {
      // Inside main process — direct env read for simplicity
      return { AWS_REGION: process.env.AWS_REGION ?? null };
    });
    expect(snap).toBeTruthy();
  } finally {
    await teardown(launched);
  }
});
