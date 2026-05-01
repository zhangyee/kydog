import path from 'node:path';
import * as tar from 'tar';
import { KydogError } from '../../shared/errors';

export async function extractTarGz(archivePath: string, destDir: string): Promise<void> {
  const destAbs = path.resolve(destDir);
  let rejection: string | null = null;
  try {
    await tar.x({
      file: archivePath,
      cwd: destDir,
      strip: 0,
      // tar's filter receives (path, entry); reject by returning false. Symlinks/hardlinks
      // can escape via linkpath even when entry.path is in-bounds, so reject those entry
      // types entirely. We also re-check entry.path against destDir.
      filter: (p, entry) => {
        const t = (entry as unknown as { type?: string }).type;
        if (t === 'SymbolicLink' || t === 'Link') {
          rejection = `archive 含 ${t} 条目（${p}）：拒绝展开`;
          return false;
        }
        const target = path.resolve(destDir, p);
        if (target !== destAbs && !target.startsWith(destAbs + path.sep)) {
          rejection = `archive 包含越界路径：${p}`;
          return false;
        }
        return true;
      },
    });
  } catch (err) {
    throw new KydogError('skill.extract_failed', `解压失败：${(err as Error).message}`);
  }
  if (rejection) {
    throw new KydogError('skill.extract_failed', rejection);
  }
}
