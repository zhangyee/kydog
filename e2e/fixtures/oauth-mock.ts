// Simple time-based fixture: triggers onAuth → onProgress → resolve
export type OAuthFixture = {
  onAuthAfterMs: number;
  url: string;
  progressMessages?: Array<{ afterMs: number; text: string }>;
  expectsManualCode?: boolean;
  successAfterMs: number;
};

export const happyPath: OAuthFixture = {
  onAuthAfterMs: 50,
  url: 'https://example.test/oauth?code=fixture',
  progressMessages: [
    { afterMs: 100, text: '等待回调…' },
    { afterMs: 200, text: '验证 token…' },
  ],
  expectsManualCode: false,
  successAfterMs: 300,
};

export const cancelPath: OAuthFixture = {
  onAuthAfterMs: 50,
  url: 'https://example.test/oauth?code=cancel',
  progressMessages: [],
  expectsManualCode: false,
  successAfterMs: 999_999,    // never completes
};
