import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createXResearchArtifactStore } from './xResearchArtifacts';
import { canonicalizeXResearchResult } from './xResearchCanonical';
import { fileService } from '../fs/fileService';
import { fixture, stagedFixture } from '../../test-support/xResearchFixture';
import { readX } from './xResearchRead';
import { searchResult } from './xResearchSearch';
import { searchInput } from '../../test-support/xResearchFixture';
import {
  SKIP_WITHOUT_SYMLINK,
  SYMLINK_SKIP_REASON,
} from '../../test-support/symlinkCapability';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'x-artifact-'));
  roots.push(root);
  const result = searchResult(searchInput, fixture([]).context);
  return { root, result, store: createXResearchArtifactStore(root) };
}
it('roundtrip_over_1MiB_unicode', async () => {
  const { root, store } = await setup();
  const raw = await readX(
    {
      tabId: 'research-tab',
      read: {
        objective: 'read',
        targets: [{ url: 'https://x.com/alice/status/123' }],
        includeArticle: true,
        includeReplies: false,
        maxRepliesPerPost: 0,
        maxScrollsPerPost: 0,
        maxExpandActionsPerPost: 3,
      },
    },
    (await stagedFixture({ article: 'ok' })).context,
  );
  raw.targets[0].article.body!.text = '汉字😀\n正文'.repeat(180000);
  raw.targets[0].article.body!.truncation = {
    returned: raw.targets[0].article.body!.text.length,
    totalKnown: raw.targets[0].article.body!.text.length,
    truncated: false,
  };
  raw.targets[0].bodyObservations = [
    {
      ...structuredClone(raw.targets[0].root!),
      observationId: 'historic-root',
      text: 'previous\n😀',
      truncation: { returned: 11, totalKnown: 11, truncated: false },
    },
  ];
  const canonical = canonicalizeXResearchResult(raw),
    ref = await store.write(raw);
  expect(await store.read(ref)).toEqual(canonical);
  expect(ref.bytes).toBeGreaterThan(1048576);
  expect(store.displayPath(ref)).toBe(
    path.join(root, ref.directoryId, 'manifest.json'),
  );
  const manifest = JSON.parse(
    await fs.readFile(store.displayPath(ref), 'utf8'),
  );
  expect(manifest.chunks.length).toBeGreaterThan(1);
  for (const chunk of manifest.chunks) {
    const content = await fs.readFile(
      path.join(root, ref.directoryId, chunk.name),
    );
    expect(content.byteLength).toBeLessThanOrEqual(1048576);
    expect(content.byteLength).toBe(chunk.bytes);
    expect(createHash('sha256').update(content).digest('hex')).toBe(
      chunk.sha256,
    );
    expect(content.equals(Buffer.from(content.toString('utf8')))).toBe(true);
  }
  const empty = searchResult(searchInput, fixture([]).context);
  empty.queries = [];
  expect(await store.read(await store.write(empty))).toEqual(empty);
});
it.each([
  'missing',
  'bytes',
  'identity',
  'traversal',
  'hash',
  'manifest-count',
  'chunk-path',
  'result-identity',
  'same-size-bytes',
] as const)('rejects %s after a successful read', async (fault) => {
  const { store, root, result } = await setup(),
    ref = await store.write(result);
  expect(await store.read(ref)).toEqual(result);
  const manifest = JSON.parse(
    await fs.readFile(store.displayPath(ref), 'utf8'),
  );
  if (fault === 'missing')
    await fs.unlink(path.join(root, ref.directoryId, manifest.chunks[0].name));
  if (fault === 'bytes')
    await fs.appendFile(
      path.join(root, ref.directoryId, manifest.chunks[0].name),
      'x',
    );
  if (fault === 'identity') ref.callId = 'other-call';
  if (fault === 'traversal') ref.directoryId = '../outside';
  if (fault === 'hash') ref.sha256 = '0'.repeat(64);
  if (fault === 'same-size-bytes') {
    const file = path.join(root, ref.directoryId, manifest.chunks[0].name);
    const bytes = await fs.readFile(file);
    bytes[0] = 32;
    await fs.writeFile(file, bytes);
  }
  if (fault === 'chunk-path') {
    manifest.chunks[0].name = '../outside';
    await fs.writeFile(store.displayPath(ref), JSON.stringify(manifest));
  }
  if (fault === 'result-identity') {
    ref.callId = 'other-call';
    manifest.callId = 'other-call';
    await fs.writeFile(store.displayPath(ref), JSON.stringify(manifest));
  }
  if (fault === 'manifest-count') {
    manifest.rows = 99;
    await fs.writeFile(store.displayPath(ref), JSON.stringify(manifest));
  }
  await expect(store.read(ref)).rejects.toMatchObject({
    name: 'XResearchArtifactError',
    code: expect.any(String),
  });
});
it.skipIf(SKIP_WITHOUT_SYMLINK)(
  `rejects directory, manifest and chunk links outside the UUID directory (${SYMLINK_SKIP_REASON})`,
  async () => {
    for (const part of ['directory', 'manifest', 'chunk']) {
      const { store, result, root } = await setup(),
        ref = await store.write(result);
      expect(await store.read(ref)).toEqual(result);
      const manifest = JSON.parse(
        await fs.readFile(store.displayPath(ref), 'utf8'),
      );
      const target =
        part === 'directory'
          ? path.join(root, ref.directoryId)
          : part === 'manifest'
            ? store.displayPath(ref)
            : path.join(root, ref.directoryId, manifest.chunks[0].name);
      const outside = path.join(root, 'outside');
      await fs.rename(target, outside);
      await fs.symlink(outside, target, part === 'directory' ? 'dir' : 'file');
      await expect(store.read(ref)).rejects.toMatchObject({ code: 'path' });
    }
  },
);
it('commits manifest last, and retries the same call in a fresh directory', async () => {
  const { root, store, result } = await setup(),
    ref = await store.write(result);
  expect(await store.read(ref)).toEqual(result);
  result.objective = 'large-body'.repeat(140000);
  const write = fileService.writeText.bind(fileService);
  vi.spyOn(fileService, 'writeText').mockImplementation(async (args) => {
    if (path.basename(args.path) === 'chunk-000001.json')
      throw new Error('disk failure');
    await write(args);
  });
  await expect(store.write(result)).rejects.toMatchObject({ code: 'write' });
  const dirs = await fs.readdir(root);
  expect(dirs).toHaveLength(2);
  const failed = dirs.find((id) => id !== ref.directoryId)!;
  expect(await fs.readdir(path.join(root, ref.directoryId))).toContain(
    'manifest.json',
  );
  expect(await fs.readdir(path.join(root, failed))).toContain(
    'chunk-000000.json',
  );
  expect(await fs.readdir(path.join(root, failed))).not.toContain(
    'manifest.json',
  );
  vi.restoreAllMocks();
  const retry = await store.write(result);
  expect(retry.directoryId).not.toBe(ref.directoryId);
  expect(await store.read(retry)).toEqual(result);
  expect(await store.read(ref)).toEqual({ ...result, objective: 'research' });
});
