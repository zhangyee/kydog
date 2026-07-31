import { describe, it, expect, afterEach, vi } from 'vitest';
import { latestStableTag, fetchShaForAsset, releaseAssetUrl, fetchDistManifest, fetchRepoTree, fetchRepoFile, releaseTagExists, listStableTags } from './github.mjs';

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

  it('fetchRepoTree returns path/type/sha for every entry', async () => {
    vi.stubGlobal('fetch', mockFetch([
      {
        match: (u) => u.includes('/git/trees/'),
        body: {
          truncated: false,
          tree: [
            { path: 'skills', mode: '040000', type: 'tree', sha: 'tttt', url: 'https://…' },
            { path: 'skills/fastpaper/SKILL.md', mode: '100644', type: 'blob', sha: 'aaaa', size: 12, url: 'https://…' },
          ],
        },
      },
    ]));
    // 保留 type：blob 过滤是 upstreamSkillHashes 的职责，这里只负责取回事实
    expect(await fetchRepoTree('o/r', 'v1.0')).toEqual([
      { path: 'skills', type: 'tree', sha: 'tttt' },
      { path: 'skills/fastpaper/SKILL.md', type: 'blob', sha: 'aaaa' },
    ]);
  });

  it('fetchRepoTree throws when GitHub truncated the tree', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { match: (u) => u.includes('/git/trees/'), body: { truncated: true, tree: [] } },
    ]));
    await expect(fetchRepoTree('o/r', 'v1.0')).rejects.toThrow(/truncated/i);
  });

  it('fetchRepoTree throws on 404 (tag missing)', async () => {
    vi.stubGlobal('fetch', mockFetch([]));
    await expect(fetchRepoTree('o/r', 'v1.0')).rejects.toThrow(/404/);
  });

  it('fetchRepoFile returns raw bytes', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { match: (u) => u.startsWith('https://raw.githubusercontent.com/o/r/v1.0/skills/x/SKILL.md'), body: 'hi\n' },
    ]));
    const buf = await fetchRepoFile('o/r', 'v1.0', 'skills/x/SKILL.md');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString('utf-8')).toBe('hi\n');
  });

  it('fetchRepoFile throws on 404', async () => {
    vi.stubGlobal('fetch', mockFetch([]));
    await expect(fetchRepoFile('o/r', 'v1.0', 'skills/x/SKILL.md')).rejects.toThrow(/404/);
  });

  it('releaseTagExists returns true when the tag has a release', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { match: (u) => u.includes('/releases/tags/v1.0'), body: { tag_name: 'v1.0' } },
    ]));
    expect(await releaseTagExists('o/r', 'v1.0')).toBe(true);
  });

  it('releaseTagExists returns false on 404', async () => {
    vi.stubGlobal('fetch', mockFetch([]));
    expect(await releaseTagExists('o/r', 'v9.9')).toBe(false);
  });

  // 限流/服务端错误绝不能被当成"这个版本不存在"——那会把人引向完全错误的方向
  it('releaseTagExists throws on a non-404 failure instead of reporting "missing"', async () => {
    vi.stubGlobal('fetch', mockFetch([
      { match: (u) => u.includes('/releases/tags/'), body: 'rate limited', status: 403 },
    ]));
    await expect(releaseTagExists('o/r', 'v1.0')).rejects.toThrow(/403/);
  });

  it('listStableTags drops drafts and prereleases, keeping API order', async () => {
    vi.stubGlobal('fetch', mockFetch([
      {
        match: (u) => u.endsWith('/releases'),
        body: [
          { tag_name: 'v2.0', draft: false, prerelease: false },
          { tag_name: 'v2.0-rc1', draft: false, prerelease: true },
          { tag_name: 'v1.9-wip', draft: true, prerelease: false },
          { tag_name: 'v1.8', draft: false, prerelease: false },
        ],
      },
    ]));
    expect(await listStableTags('o/r')).toEqual(['v2.0', 'v1.8']);
  });

  it('listStableTags respects the limit', async () => {
    vi.stubGlobal('fetch', mockFetch([
      {
        match: (u) => u.endsWith('/releases'),
        body: [
          { tag_name: 'v3', draft: false, prerelease: false },
          { tag_name: 'v2', draft: false, prerelease: false },
          { tag_name: 'v1', draft: false, prerelease: false },
        ],
      },
    ]));
    expect(await listStableTags('o/r', 2)).toEqual(['v3', 'v2']);
  });
});
