// Simple time-based fixture: triggers (select) → onAuth → onProgress → resolve
export type OAuthFixture = {
  // 真实的 Codex 流程里 select 是第一步，早于 auth_url —— 这里保持同样的顺序。
  selectBeforeAuth?: {
    message: string;
    options: Array<{ id: string; label: string; description?: string }>;
  };
  onAuthAfterMs: number;
  url: string;
  progressMessages?: Array<{ afterMs: number; text: string }>;
  expectsManualCode?: boolean;
  successAfterMs: number;
};

// 照抄 pi openai-codex 的选项（含英文措辞）：UI 必须原样显示 provider 给的 label。
export const selectPath: OAuthFixture = {
  selectBeforeAuth: {
    message: 'Select OpenAI Codex login method:',
    options: [
      { id: 'browser', label: 'Browser login (default)' },
      { id: 'device_code', label: 'Device code login (headless)' },
    ],
  },
  onAuthAfterMs: 50,
  url: 'https://example.test/oauth?code=select',
  progressMessages: [],
  expectsManualCode: false,
  successAfterMs: 999_999,    // never completes：选完之后停在授权页，方便断言
};
