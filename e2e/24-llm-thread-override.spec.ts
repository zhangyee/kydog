import { test, expect } from '@playwright/test';
import { launchKydog, teardown } from './helpers';

test.skip('24-llm: thread modelOverride persists across reload', async () => {
  const launched = await launchKydog({ });
  const { page } = launched;
  try {
    // 1. Seed Anthropic + OpenAI, create thread
    // 2. Open InputPill menu, select OpenAI / gpt-4o
    // 3. Assert InputPill shows OpenAI · gpt-4o with ⓘ
    // 4. Restart app, reopen thread, assert override persisted
    await expect(page).toBeTruthy();
  } finally {
    await teardown(launched);
  }
});
