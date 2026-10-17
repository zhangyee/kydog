import { randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { fileService } from '../fs/fileService';
import {
  canonicalizeXResearchResult,
  parseXResearchCanonical,
} from './xResearchCanonical';
import type { XArtifactRef, XResearchResult } from './xResearchTypes';

export interface XResearchArtifactStore {
  write(result: XResearchResult): Promise<XArtifactRef>;
  read(ref: XArtifactRef): Promise<XResearchResult>;
  /** 这份 ref 的工件文件在哪：与 `read` 同一个双根定位，所以对旧根里的 ref 也给得出真路径。
   *  交给模型的路径（`artifactPath`）只能来自这里。 */
  locate(ref: XArtifactRef): Promise<string>;
  /** 这个 store 把工件写在哪。不做 I/O，因此只答得出写下去的那一棵根 —— 模型可见的路径
   *  不许用它（旧根里的 ref 会得到一个不存在的路径），用 `locate`。 */
  displayPath(ref: XArtifactRef): string;
}
/** 工件的两个根。`task` 是新位置（`<X_RESEARCH_DIR>/<threadId>/<runId>/artifact`）—— 写只写这里；
 *  `legacy` 是改造前按会话落的那一棵（`<sessionsDir>/<sessionId>.x-research`）：旧 transcript 里的
 *  ref 只认得它，所以定位与读都要两棵都找。**两个根都必填**：漏掉 `legacy` 不会有什么报错，
 *  只会让旧根里的历史证据静默消失。旧根只读，绝不再写 —— 新工件只有一个归属。 */
export type XResearchArtifactRoots = {
  task: string;
  legacy: string;
};
export class XResearchArtifactError extends Error {
  readonly name = 'XResearchArtifactError';
  constructor(
    readonly code:
      | 'reference'
      | 'path'
      | 'read'
      | 'write'
      | 'integrity'
      | 'canonical',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
const CHUNK_BYTES = 1048576; // Legacy reader hard ceiling.
const WRITE_CHUNK_BYTES = 32768; // Fits the installed SDK read tool, even on one line.
const count = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const refSchema = z.object({
  version: z.literal(1),
  directoryId: z
    .string()
    .regex(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    ),
  manifest: z.literal('manifest.json'),
  sha256: hash,
  bytes: count.positive(),
  runId: z.string().min(1),
  callId: z.string().min(1),
  batchId: z.string().min(1),
  operation: z.enum(['search', 'read']),
});
const manifestSchema = refSchema.extend({
  chunks: z
    .array(
      z.object({
        name: z.string(),
        bytes: count.positive().max(CHUNK_BYTES),
        sha256: hash,
      }),
    )
    .min(1),
  rows: count,
  bodies: count,
});
const digest = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
function decodeUtf8(bytes: Uint8Array): string {
  try {
    // A leading U+FEFF may be actual body text at a chunk boundary.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (cause) {
    throw new XResearchArtifactError(
      'integrity',
      'Artifact contains invalid UTF-8',
      { cause },
    );
  }
}
const chunkName = (index: number) =>
  `chunk-${String(index).padStart(6, '0')}.json`;
function checkedRef(raw: unknown): XArtifactRef {
  const parsed = refSchema.safeParse(raw);
  if (!parsed.success)
    throw new XResearchArtifactError(
      'reference',
      'Invalid X artifact reference',
    );
  return parsed.data;
}
function inventory(result: XResearchResult): { rows: number; bodies: number } {
  return result.operation === 'search'
    ? {
        rows: result.queries.length,
        bodies: result.queries.reduce(
          (n, r) => n + r.posts.length + (r.postObservations?.length ?? 0),
          0,
        ),
      }
    : {
        rows: result.targets.length,
        bodies: result.targets.reduce(
          (n, r) =>
            n +
            (r.root ? 1 : 0) +
            r.quotedPosts.length +
            (r.article.body ? 1 : 0) +
            r.replies.observations.length +
            (r.bodyObservations?.length ?? 0) +
            (r.unscopedPosts?.observations.length ?? 0),
          0,
        ),
      };
}
/** Iterate code points, so no surrogate pair/UTF-8 sequence crosses a chunk boundary. */
function* chunks(text: string): Generator<string> {
  let start = 0,
    offset = 0,
    bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > WRITE_CHUNK_BYTES) {
      yield text.slice(start, offset);
      start = offset;
      bytes = 0;
    }
    bytes += size;
    offset += character.length;
  }
  if (offset > start) yield text.slice(start, offset);
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
function within(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
/** 单根写法是改造前的接线形态（Task 9 换成双根）：写与读都落在那一个根上，行为一字不变。 */
export function createXResearchArtifactStore(
  roots: string | XResearchArtifactRoots,
): XResearchArtifactStore {
  const writeBase = path.resolve(typeof roots === 'string' ? roots : roots.task);
  const readBases = typeof roots === 'string'
    ? [writeBase]
    : [...new Set([writeBase, path.resolve(roots.legacy)])];
  const displayPath = (raw: XArtifactRef) => {
    const ref = checkedRef(raw);
    return path.join(writeBase, ref.directoryId, ref.manifest);
  };
  /** 双根定位：任务根优先，那里没有这个目录才看旧根。**一旦某个根里有它，就由这个根说话** ——
   *  不在两棵根之间「坏的那个让位给好的那个」，否则一个被改坏的工件会被另一棵里的同名目录顶掉。
   *  每个根各自做一次 realpath 收容检查：工件目录不许逃出它所在的那棵根，也不许别名到别的工件。
   *  回给调用方两样东西：命中的那棵根（原样的配置路径，路径展示用它）与它的 realpath（收容检查用它）。 */
  async function directory(ref: XArtifactRef): Promise<{ base: string; dir: string }> {
    for (const base of readBases) {
      const realRoot = await fs.realpath(base).catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
      if (realRoot === null) continue;
      const expected = path.join(realRoot, ref.directoryId);
      const real = await fs.realpath(path.join(base, ref.directoryId)).catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
      if (real === null) continue;
      // An opaque directory may not alias a different artifact, even inside the root.
      if (real !== expected)
        throw new XResearchArtifactError(
          'path',
          'Artifact directory escaped its identity',
        );
      return { base, dir: real };
    }
    // 两棵根都没有它：与改造前「目录不存在」同一个说法（`read`）。
    throw new XResearchArtifactError(
      'read',
      'Artifact directory is missing from every root',
    );
  }
  async function locate(raw: XArtifactRef): Promise<string> {
    const ref = checkedRef(raw);
    try {
      const { base, dir } = await directory(ref);
      const file = path.join(base, ref.directoryId, ref.manifest);
      if (!within(dir, await fs.realpath(file)))
        throw new XResearchArtifactError(
          'path',
          'Artifact file escaped its directory',
        );
      return file;
    } catch (cause) {
      if (cause instanceof XResearchArtifactError) throw cause;
      throw new XResearchArtifactError('read', 'Could not locate X artifact', {
        cause,
      });
    }
  }
  async function readWithin(
    dir: string,
    name: string,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const real = await fs.realpath(path.join(dir, name));
    if (!within(dir, real))
      throw new XResearchArtifactError(
        'path',
        'Artifact file escaped its directory',
      );
    // Keep the artifact-specific ceilings before allocating through the shared
    // binary reader, and recheck actual bytes in case the file changed after stat.
    if ((await fs.stat(real)).size > maxBytes)
      throw new XResearchArtifactError(
        'integrity',
        'Artifact file exceeds its byte limit',
      );
    const { bytes } = await fileService.readBytes({ path: real });
    if (bytes.byteLength > maxBytes)
      throw new XResearchArtifactError(
        'integrity',
        'Artifact file exceeds its byte limit',
      );
    return bytes;
  }
  return {
    locate,
    displayPath,
    async write(result) {
      let canonical: XResearchResult;
      try {
        canonical = canonicalizeXResearchResult(result);
      } catch (cause) {
        throw new XResearchArtifactError(
          'canonical',
          'Invalid public X result',
          { cause },
        );
      }
      const text = JSON.stringify(canonical);
      const ref: XArtifactRef = {
        version: 1,
        directoryId: randomUUID(),
        manifest: 'manifest.json',
        sha256: digest(text),
        bytes: Buffer.byteLength(text, 'utf8'),
        runId: canonical.runId,
        callId: canonical.callId,
        batchId: canonical.batchId,
        operation: canonical.operation,
      };
      try {
        await fs.mkdir(writeBase, { recursive: true });
        await fs.mkdir(path.join(writeBase, ref.directoryId));
        const { dir } = await directory(ref),
          entries: z.infer<typeof manifestSchema>['chunks'] = [];
        for (const content of chunks(text)) {
          const name = chunkName(entries.length);
          await fileService.writeText({ path: path.join(dir, name), content });
          entries.push({
            name,
            bytes: Buffer.byteLength(content, 'utf8'),
            sha256: digest(content),
          });
        }
        const manifest = JSON.stringify({
          ...ref,
          chunks: entries,
          ...inventory(canonical),
        }, null, 2);
        // The shared reader's 2 MiB limit applies to the manifest as well.
        if (Buffer.byteLength(manifest, 'utf8') > 2 * CHUNK_BYTES)
          throw new XResearchArtifactError(
            'write',
            'Artifact manifest exceeds the file reader limit',
          );
        await fileService.writeText({
          path: path.join(dir, ref.manifest),
          content: manifest,
        });
        return ref;
      } catch (cause) {
        throw new XResearchArtifactError(
          'write',
          'Could not commit X artifact',
          { cause },
        );
      }
    },
    async read(raw) {
      const ref = checkedRef(raw);
      try {
        const { dir } = await directory(ref);
        const parsed = manifestSchema.safeParse(
          JSON.parse(
            decodeUtf8(await readWithin(dir, ref.manifest, 2 * CHUNK_BYTES)),
          ),
        );
        if (!parsed.success)
          throw new XResearchArtifactError(
            'integrity',
            'Invalid artifact manifest',
          );
        const manifest = parsed.data;
        if (JSON.stringify(checkedRef(manifest)) !== JSON.stringify(ref))
          throw new XResearchArtifactError(
            'integrity',
            'Artifact reference does not match manifest',
          );
        const parts: string[] = [];
        const totalHash = createHash('sha256');
        let totalBytes = 0;
        for (const [index, chunk] of manifest.chunks.entries()) {
          if (chunk.name !== chunkName(index))
            throw new XResearchArtifactError(
              'integrity',
              'Invalid artifact chunk order or name',
            );
          const content = await readWithin(dir, chunk.name, CHUNK_BYTES);
          if (
            content.byteLength !== chunk.bytes ||
            digest(content) !== chunk.sha256
          )
            throw new XResearchArtifactError(
              'integrity',
              'Artifact chunk checksum mismatch',
            );
          totalHash.update(content);
          totalBytes += content.byteLength;
          parts.push(decodeUtf8(content));
        }
        const text = parts.join('');
        if (totalBytes !== ref.bytes || totalHash.digest('hex') !== ref.sha256)
          throw new XResearchArtifactError(
            'integrity',
            'Artifact checksum mismatch',
          );
        let canonical: XResearchResult;
        try {
          canonical = parseXResearchCanonical(JSON.parse(text));
        } catch (cause) {
          throw new XResearchArtifactError(
            'canonical',
            'Invalid artifact public DTO',
            { cause },
          );
        }
        if (
          canonical.runId !== ref.runId ||
          canonical.callId !== ref.callId ||
          canonical.batchId !== ref.batchId ||
          canonical.operation !== ref.operation
        )
          throw new XResearchArtifactError(
            'integrity',
            'Artifact result identity mismatch',
          );
        const counts = inventory(canonical);
        if (counts.rows !== manifest.rows || counts.bodies !== manifest.bodies)
          throw new XResearchArtifactError(
            'integrity',
            'Artifact inventory mismatch',
          );
        return canonical;
      } catch (cause) {
        if (cause instanceof XResearchArtifactError) throw cause;
        throw new XResearchArtifactError('read', 'Could not read X artifact', {
          cause,
        });
      }
    },
  };
}
