import { describe, it, expect } from 'vitest';
import { GITHUB_SLUG, RELEASES_LATEST_URL, buildFeedUrl } from './constants';

describe('update constants', () => {
  it('slug 只有一处来源，Release 页与 feed 都由它拼出', () => {
    expect(GITHUB_SLUG).toBe('zhangyee/kydog');
    expect(RELEASES_LATEST_URL).toBe('https://github.com/zhangyee/kydog/releases/latest');
  });

  it('feed URL 形如 /slug/platform-arch/version', () => {
    expect(buildFeedUrl('darwin', 'arm64', '0.1.0'))
      .toBe('https://update.electronjs.org/zhangyee/kydog/darwin-arm64/0.1.0');
    expect(buildFeedUrl('win32', 'x64', '0.2.0'))
      .toBe('https://update.electronjs.org/zhangyee/kydog/win32-x64/0.2.0');
  });
});
