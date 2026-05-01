import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as tar from 'tar';

export function mkTmp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export async function makeTarball(opts: {
  entries: { path: string; content: string }[];
}): Promise<string> {
  const stage = mkTmp('tar-stage-');
  for (const e of opts.entries) {
    const p = path.join(stage, e.path);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, e.content);
  }
  const out = path.join(mkTmp('tar-out-'), 'a.tar.gz');
  await tar.c(
    { gzip: true, file: out, cwd: stage },
    opts.entries.map((e) => e.path),
  );
  return out;
}
