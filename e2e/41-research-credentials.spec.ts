import { test, expect } from '@playwright/test';
import { launchKydog, teardown } from './helpers';

test('41-research: 保存密钥 → 主进程 process.env 生效；清空 → 变量消失', async () => {
  const launched = await launchKydog({ env: { KYDOG_E2E: '1' } });
  const { page, app } = launched;
  try {
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="open-research"]').click();

    const ncbi = page.locator('[data-testid="research-var-NCBI_API_KEY"] input');
    const email = page.locator('[data-testid="research-var-UNPAYWALL_EMAIL"] input');
    await expect(ncbi).toBeVisible();

    await ncbi.fill('ncbi-test-key');
    await email.fill('e2e@example.com');
    await page.locator('[data-testid="research-save"]').click();
    await expect(page.locator('[data-testid="research-saved"]')).toBeVisible();

    const after = await app.evaluate(async () => ({
      NCBI_API_KEY: process.env.NCBI_API_KEY ?? null,
      UNPAYWALL_EMAIL: process.env.UNPAYWALL_EMAIL ?? null,
    }));
    expect(after.NCBI_API_KEY).toBe('ncbi-test-key');
    expect(after.UNPAYWALL_EMAIL).toBe('e2e@example.com');

    // 清空邮箱后保存：该变量从 env 消失，另一个不受影响
    await email.fill('');
    await page.locator('[data-testid="research-save"]').click();
    await expect(page.locator('[data-testid="research-saved"]')).toBeVisible();

    const cleared = await app.evaluate(async () => ({
      NCBI_API_KEY: process.env.NCBI_API_KEY ?? null,
      UNPAYWALL_EMAIL: process.env.UNPAYWALL_EMAIL ?? null,
    }));
    expect(cleared.UNPAYWALL_EMAIL).toBeNull();
    expect(cleared.NCBI_API_KEY).toBe('ncbi-test-key');
  } finally {
    await teardown(launched);
  }
});

test('41-research: 未确认的新变量拦住保存；显隐状态跨保存保持', async () => {
  const launched = await launchKydog({ env: { KYDOG_E2E: '1' } });
  const { page } = launched;
  try {
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="open-research"]').click();

    // 填了新变量但不点「确定」→ 保存必须被拦住，否则内容会静默丢失
    await page.locator('[data-testid="research-add-var"]').click();
    await page.locator('[data-testid="research-new-name"]').fill('AAA_VAR');
    await page.locator('[data-testid="research-new-value"]').fill('secret-aaa');
    await expect(page.locator('[data-testid="research-save"]')).toBeDisabled();
    await expect(page.locator('[data-testid="research-save-blocked"]')).toBeVisible();

    await page.locator('[data-testid="research-new-confirm"]').click();
    await expect(page.locator('[data-testid="research-save"]')).toBeEnabled();

    // 点开「显示」后保存，展开状态必须保持 —— uid 每次保存重新发号会让它被收回
    const row = page.locator('[data-testid="research-var-AAA_VAR"]');
    await expect(row.locator('input')).toHaveAttribute('type', 'password');
    await row.getByRole('button', { name: '显示' }).click();
    await expect(row.locator('input')).toHaveAttribute('type', 'text');

    await page.locator('[data-testid="research-save"]').click();
    await expect(page.locator('[data-testid="research-saved"]')).toBeVisible();
    await expect(row.locator('input')).toHaveAttribute('type', 'text');
    await expect(row.locator('input')).toHaveValue('secret-aaa');
  } finally {
    await teardown(launched);
  }
});

test('41-research: 邮箱格式非法 → 报错且不写 env', async () => {
  const launched = await launchKydog({ env: { KYDOG_E2E: '1' } });
  const { page, app } = launched;
  try {
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="open-research"]').click();

    await page.locator('[data-testid="research-var-UNPAYWALL_EMAIL"] input').fill('not-an-email');
    await page.locator('[data-testid="research-save"]').click();

    await expect(page.locator('[data-testid="research-error"]')).toBeVisible();
    const snap = await app.evaluate(async () => process.env.UNPAYWALL_EMAIL ?? null);
    expect(snap).toBeNull();
  } finally {
    await teardown(launched);
  }
});

test('41-research: 自定义变量落到 env；保留变量名被拦下', async () => {
  const launched = await launchKydog({ env: { KYDOG_E2E: '1' } });
  const { page, app } = launched;
  try {
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="open-research"]').click();

    await page.locator('[data-testid="research-add-var"]').click();
    await page.locator('[data-testid="research-new-name"]').fill('PATH');
    await page.locator('[data-testid="research-new-value"]').fill('hijacked');
    await page.locator('[data-testid="research-new-confirm"]').click();
    await expect(page.getByText('保留变量名', { exact: false })).toBeVisible();

    await page.locator('[data-testid="research-new-name"]').fill('MY_SOURCE_API_KEY');
    await page.locator('[data-testid="research-new-confirm"]').click();
    await page.locator('[data-testid="research-save"]').click();
    await expect(page.locator('[data-testid="research-saved"]')).toBeVisible();

    const snap = await app.evaluate(async () => ({
      MY_SOURCE_API_KEY: process.env.MY_SOURCE_API_KEY ?? null,
      PATH_HIJACKED: process.env.PATH === 'hijacked',
    }));
    expect(snap.MY_SOURCE_API_KEY).toBe('hijacked');
    expect(snap.PATH_HIJACKED).toBe(false);
  } finally {
    await teardown(launched);
  }
});
