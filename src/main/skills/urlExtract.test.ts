import { describe, it, expect } from 'vitest';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';
import { extractTarGz } from './urlExtract';
import { makeTarball, mkTmp } from './__fixtures__/makeTarball';

function tmp(): string {
  return mkTmp('tar-');
}

describe('extractTarGz', () => {
  it('extracts files under destDir', async () => {
    const archive = await makeTarball({
      entries: [{ path: 'repo-1/SKILL.md', content: '---\nname: a\ndescription: d\n---' }],
    });
    const dest = tmp();
    await extractTarGz(archive, dest);
    expect(existsSync(path.join(dest, 'repo-1', 'SKILL.md'))).toBe(true);
  });

  it('rejects entries that escape destDir', async () => {
    const stage = tmp();
    const benign = path.join(stage, 'ok.txt');
    writeFileSync(benign, 'ok');
    const out = path.join(tmp(), 'evil.tar.gz');
    await tar.c({ gzip: true, file: out, cwd: stage, prefix: '../escape' }, ['ok.txt']);
    const dest = tmp();
    await expect(extractTarGz(out, dest)).rejects.toThrow(
      /skill\.extract_failed|越界|extract_failed/,
    );
  });

  it.skipIf(process.platform === 'win32')('rejects symlink entries', async () => {
    const { symlinkSync } = await import('node:fs');
    const stage = tmp();
    writeFileSync(path.join(stage, 'real.txt'), 'real');
    symlinkSync('/etc/passwd', path.join(stage, 'evil-link'));
    const out = path.join(tmp(), 'sym.tar.gz');
    await tar.c({ gzip: true, file: out, cwd: stage }, ['real.txt', 'evil-link']);
    const dest = tmp();
    await expect(extractTarGz(out, dest)).rejects.toThrow(
      /SymbolicLink|skill\.extract_failed|拒绝|extract_failed/,
    );
  });
});
