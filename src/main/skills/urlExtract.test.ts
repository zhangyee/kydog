import { describe, it, expect } from 'vitest';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import * as tar from 'tar';
import { extractTarGz } from './urlExtract';
import { makeTarball, mkTmp } from './__fixtures__/makeTarball';
import { SKIP_WITHOUT_SYMLINK } from '../../test-support/symlinkCapability';

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

  // 拒绝的判据是 tar entry 的 type（urlExtract.ts 的 filter），与平台无关；这里唯一
  // 需要平台配合的是**造夹具**——得先建出一个软链才能打进 tar。所以按能力探针跳，
  // 不按平台名字跳：开了开发者模式的 Windows 建得出来，就该真跑。
  it.skipIf(SKIP_WITHOUT_SYMLINK)('rejects symlink entries', async () => {
    const { symlinkSync } = await import('node:fs');
    const stage = tmp();
    writeFileSync(path.join(stage, 'real.txt'), 'real');
    symlinkSync('/etc/passwd', path.join(stage, 'evil-link'));
    const out = path.join(tmp(), 'sym.tar.gz');
    await tar.c({ gzip: true, file: out, cwd: stage }, ['real.txt', 'evil-link']);
    const dest = tmp();
    // 钉死是 filter 里那条软链分支拒的，而不是 tar.x 因为别的原因抛了
    // ——原来那个 `skill.extract_failed|extract_failed` 的宽正则任何解压失败都能匹配上，
    // 在这条刚被放开跑的平台上，等于允许它因为错误的理由变绿。
    await expect(extractTarGz(out, dest)).rejects.toThrow(/含 SymbolicLink 条目/);
  });
});
