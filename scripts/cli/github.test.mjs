import { describe, it, expect, afterEach, vi } from 'vitest';
import { latestStableTag, fetchShaForAsset, releaseAssetUrl, fetchDistManifest } from './github.mjs';

function mockFetch(handlers) {
  // handlers: array of { match: (url) => bool, body, status }
  return vi.fn(async (url) => {
    for (const h of handlers) {
      if (h.match(url)) {
        return new Response(typeof h.body === 'string' ? h.body : JSON.stringify(h.body), { status: h.status ?? 200 });
      }
    }
    return new Response('not found', { status: 404 });
  });
}

describe('github', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('latestStableTag returns tag_name from /releases/latest', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { match: (u) => u.includes('/releases/latest'), body: { tag_name: 'v1.2.3' } },
    ]));
    expect(await latestStableTag('o/r')).toBe('v1.2.3');
  });

  it('latestStableTag throws on 404', async () => {
    vi.stubGlobal('fetch', mockFetch([]));
    await expect(latestStableTag('o/r')).rejects.toThrow(/404/);
  });

  it('releaseAssetUrl composes correctly', () => {
    expect(releaseAssetUrl('o/r', 'v1.0', 'x.tar.xz')).toBe('https://github.com/o/r/releases/download/v1.0/x.tar.xz');
  });

  it('fetchShaForAsset parses "<sha>  <filename>" single line', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { match: (u) => u.endsWith('.sha256'), body: 'abc123  x.tar.xz\n' },
    ]));
    expect(await fetchShaForAsset('o/r', 'v1.0', 'x.tar.xz')).toBe('abc123');
  });

  it('fetchShaForAsset accepts raw sha (no filename)', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { match: (u) => u.endsWith('.sha256'), body: 'abc123\n' },
    ]));
    expect(await fetchShaForAsset('o/r', 'v1.0', 'x.tar.xz')).toBe('abc123');
  });

  it('fetchShaForAsset throws on 404', async () => {
    vi.stubGlobal('fetch', mockFetch([]));
    await expect(fetchShaForAsset('o/r', 'v1.0', 'x.tar.xz')).rejects.toThrow(/sha256.*404|no SHASUMS/i);
  });

  it('fetchDistManifest returns parsed JSON', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { match: (u) => u.endsWith('dist-manifest.json'), body: { artifacts: {} } },
    ]));
    expect(await fetchDistManifest('o/r', 'v1.0')).toEqual({ artifacts: {} });
  });

  it('fetchDistManifest returns null on 404', async () => {
    vi.stubGlobal('fetch', mockFetch([]));
    expect(await fetchDistManifest('o/r', 'v1.0')).toBeNull();
  });
});
