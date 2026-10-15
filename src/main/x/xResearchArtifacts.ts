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
  displayPath(ref: XArtifactRef): string;
}
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
function within(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
export function createXResearchArtifactStore(
  root: string,
): XResearchArtifactStore {
  const base = path.resolve(root);
  const displayPath = (raw: XArtifactRef) => {
    const ref = checkedRef(raw);
    return path.join(base, ref.directoryId, ref.manifest);
  };
  async function directory(ref: XArtifactRef): Promise<string> {
    const realRoot = await fs.realpath(base),
      expected = path.join(realRoot, ref.directoryId);
    const real = await fs.realpath(path.join(base, ref.directoryId));
    // An opaque directory may not alias a different artifact, even inside the root.
    if (real !== expected)
      throw new XResearchArtifactError(
        'path',
        'Artifact directory escaped its identity',
      );
    return real;
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
        await fs.mkdir(base, { recursive: true });
        await fs.mkdir(path.join(base, ref.directoryId));
        const dir = await directory(ref),
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
        const dir = await directory(ref);
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
