import { describe, expect, it } from 'vitest';
import { resolveSourceUrls } from './sourceUrl';

describe('resolveSourceUrls', () => {
  it('maps an HTTPS GitHub blob page to Raw while keeping the report URL', () => {
    expect(resolveSourceUrls('https://github.com/owner/repo/blob/main/docs/guide.md')).toEqual({
      contentUrl: 'https://raw.githubusercontent.com/owner/repo/main/docs/guide.md',
      reportUrl: 'https://github.com/owner/repo/blob/main/docs/guide.md',
    });
  });

  it('preserves percent-encoded ref and path segments byte-for-byte', () => {
    expect(resolveSourceUrls('https://github.com/o/r/blob/release%2Fv1/docs/a%20b.md')).toEqual({
      contentUrl: 'https://raw.githubusercontent.com/o/r/release%2Fv1/docs/a%20b.md',
      reportUrl: 'https://github.com/o/r/blob/release%2Fv1/docs/a%20b.md',
    });
  });

  it.each([
    'http://github.com/o/r/blob/main/a.md',
    'https://user:pass@github.com/o/r/blob/main/a.md',
    'https://github.com/o/r/tree/main/a.md',
    'https://github.com/o/r/releases/tag/v1',
    'https://github.com/o/r/issues/1',
    'https://raw.githubusercontent.com/o/r/main/a.md',
    'https://github.com/o/r/blob/main',
  ])('does not rewrite %s', (url) => {
    expect(resolveSourceUrls(url)).toEqual({ contentUrl: url, reportUrl: url });
  });
});
