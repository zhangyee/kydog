import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createXResearchArtifactStore } from './xResearchArtifacts';
import { canonicalizeXResearchResult } from './xResearchCanonical';
import { fileService } from '../fs/fileService';
import {
  fixture,
  stagedFixture,
  post,
  searchHtml,
} from '../../test-support/xResearchFixture';
import { readX } from './xResearchRead';
import { searchResult, searchX } from './xResearchSearch';
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

it.each(['chunk', 'manifest'] as const)(
  'rejects invalid UTF-8 replacing valid U+FFFD in %s without changing the reference',
  async (part) => {
    const { root, store } = await setup();
    const result = await searchX(
      searchInput,
      fixture([searchHtml(post('123', 'alice', 'valid body: \uFFFD'))]).context,
    );
    if (part === 'manifest') result.callId = 'call-\uFFFD';
    const ref = await store.write(result);
    expect(await store.read(ref)).toEqual(result);
    const manifest = JSON.parse(
      await fs.readFile(store.displayPath(ref), 'utf8'),
    );
    const file =
      part === 'manifest'
        ? store.displayPath(ref)
        : path.join(root, ref.directoryId, manifest.chunks[0].name);
    const original = await fs.readFile(file);
    const offset = original.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
    expect(offset).toBeGreaterThanOrEqual(0);
    const corrupt = Buffer.concat([
      original.subarray(0, offset),
      Buffer.from([0xff]),
      original.subarray(offset + 3),
    ]);
    expect(corrupt.toString('utf8')).toBe(original.toString('utf8'));
    expect(corrupt.byteLength).toBe(original.byteLength - 2);
    await fs.writeFile(file, corrupt);
    await expect(store.read(ref)).rejects.toMatchObject({ code: 'integrity' });
  },
);

it('rejects invalid UTF-8 even when raw chunk length and hashes match the reference', async () => {
  const { root, store, result } = await setup();
  result.objective = 'replacement \uFFFD';
  const ref = await store.write(result);
  expect(await store.read(ref)).toEqual(result);
  const manifest = JSON.parse(
    await fs.readFile(store.displayPath(ref), 'utf8'),
  );
  expect(manifest.chunks).toHaveLength(1);
  const chunk = manifest.chunks[0],
    file = path.join(root, ref.directoryId, chunk.name);
  const original = await fs.readFile(file),
    offset = original.indexOf(Buffer.from([0xef, 0xbf, 0xbd]));
  expect(offset).toBeGreaterThanOrEqual(0);
  const corrupt = Buffer.concat([
    original.subarray(0, offset),
    Buffer.from([0xff]),
    original.subarray(offset + 3),
  ]);
  ref.bytes = manifest.bytes = chunk.bytes = corrupt.byteLength;
  ref.sha256 =
    manifest.sha256 =
    chunk.sha256 =
      createHash('sha256').update(corrupt).digest('hex');
  await fs.writeFile(file, corrupt);
  await fs.writeFile(store.displayPath(ref), JSON.stringify(manifest));
  await expect(store.read(ref)).rejects.toMatchObject({
    code: 'integrity',
    message: expect.stringContaining('UTF-8'),
  });
});

it('retains the 2 MiB manifest read ceiling after switching to binary reads', async () => {
  const { store, result } = await setup(),
    ref = await store.write(result);
  const file = store.displayPath(ref),
    manifest = await fs.readFile(file);
  await fs.writeFile(
    file,
    Buffer.concat([
      manifest,
      Buffer.alloc(2 * 1048576 - manifest.byteLength, 32),
    ]),
  );
  expect(await store.read(ref)).toEqual(result);
  await fs.appendFile(file, ' ');
  await expect(store.read(ref)).rejects.toMatchObject({
    name: 'XResearchArtifactError',
  });
});

it('preserves a valid U+FEFF character at the beginning of a later chunk', async () => {
  const { root, store, result } = await setup();
  result.objective = 'START';
  const canonical = JSON.stringify(canonicalizeXResearchResult(result));
  const prefixBytes = Buffer.byteLength(
    canonical.slice(0, canonical.indexOf('START')),
    'utf8',
  );
  result.objective = 'x'.repeat(32768 - prefixBytes) + '\uFEFF正文';
  const ref = await store.write(result);
  const manifest = JSON.parse(
    await fs.readFile(store.displayPath(ref), 'utf8'),
  );
  const bytes = await fs.readFile(
    path.join(root, ref.directoryId, manifest.chunks[1].name),
  );
  expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(
    true,
  );
  expect(await store.read(ref)).toEqual(result);
});

it('new artifacts are fully readable through installed SDK read, with manifest line continuation',async()=>{
 const {root,store,result}=await setup();
 result.objective='汉字😀'.repeat(120000);
 const ref=await store.write(result);
 const {createReadToolDefinition}=await import('@earendil-works/pi-coding-agent');
 const read=createReadToolDefinition(root);
 const readText=async(file:string,offset?:number,limit?:number)=>{
  const value=await read.execute('read',{path:file,offset,limit},undefined,undefined,{} as never);
  return value.content.map(item=>item.type==='text'?item.text:'').join('');
 };
 let offset=1;const lines:string[]=[];
 for(;;){
  const text=await readText(store.displayPath(ref),offset,40);
  const continuation=/\n\n\[\d+ more lines in file\. Use offset=(\d+) to continue\.\]$/.exec(text);
  lines.push(continuation?text.slice(0,continuation.index):text);
  if(!continuation)break;
  offset=Number(continuation[1]);
 }
 const manifest=JSON.parse(lines.join('\n'));
 expect(offset).toBeGreaterThan(1);
 const fragments=[];
 for(const chunk of manifest.chunks){
  const text=await readText(path.join(root,ref.directoryId,chunk.name));
  expect(createHash('sha256').update(text).digest('hex')).toBe(chunk.sha256);
  fragments.push(text);
 }
 const complete=fragments.join('');
 expect(Buffer.byteLength(complete)).toBe(ref.bytes);
 expect(createHash('sha256').update(complete).digest('hex')).toBe(ref.sha256);
 expect(JSON.parse(complete)).toEqual(result);
});

it('reads legacy single chunks up to the original 1 MiB ceiling',async()=>{
 const {root,store,result}=await setup();result.objective='legacy'.repeat(10000);
 const ref=await store.write(result),file=store.displayPath(ref);
 const manifest=JSON.parse(await fs.readFile(file,'utf8'));
 const content=JSON.stringify(canonicalizeXResearchResult(result));
 expect(Buffer.byteLength(content)).toBeGreaterThan(32768);
 const chunk={name:'chunk-000000.json',bytes:ref.bytes,sha256:ref.sha256};
 await fs.writeFile(path.join(root,ref.directoryId,chunk.name),content);
 manifest.chunks=[chunk];await fs.writeFile(file,JSON.stringify(manifest));
 expect(await store.read(ref)).toEqual(result);
 await fs.writeFile(path.join(root,ref.directoryId,chunk.name),' '.repeat(1048577));
 await expect(store.read(ref)).rejects.toMatchObject({code:'integrity'});
});
