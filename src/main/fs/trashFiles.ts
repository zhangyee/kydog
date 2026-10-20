import { promises as fs } from 'node:fs';
import path from 'node:path';
import { shell } from 'electron';
import { KydogError, serializeError } from '../../shared/errors';
import { isTrashablePath, type TrashFilesArgs, type TrashFilesResult } from '../../shared/files';
import { loadIndex } from '../persist/indexFile';

function errorDetail(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return `${err instanceof Error ? err.message : String(err)}${code ? ` (${code})` : ''}`;
}

async function checkTarget(realRoot: string, target: string): Promise<void> {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new KydogError('fs.access_denied', `${target} 不是普通文件`);
  }
  const realTarget = await fs.realpath(target);
  const relative = path.relative(realRoot, realTarget);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new KydogError('fs.access_denied', `${target} 不在项目内部`);
  }
}

export async function trashFiles(args: TrashFilesArgs): Promise<TrashFilesResult> {
  // RPC arguments are untrusted at runtime; reject malformed input before using path/fs APIs.
  if (!args || typeof args.projectPath !== 'string' || !path.isAbsolute(args.projectPath)
    || !Array.isArray(args.paths) || !args.paths.every((target) => typeof target === 'string'
      && path.isAbsolute(target) && isTrashablePath(target))) {
    throw new KydogError('fs.access_denied', '废纸篓请求需要项目绝对路径及受支持文件的绝对路径数组');
  }
  const targets = [...new Set(args.paths)];
  const index = await loadIndex();
  if (!index.projects.some((project) => project.path === args.projectPath)) {
    throw new KydogError('fs.access_denied', `项目未登记：${args.projectPath}`);
  }

  let realRoot: string;
  try {
    realRoot = await fs.realpath(args.projectPath);
    if (!(await fs.stat(realRoot)).isDirectory()) throw new Error('项目根不是目录');
    // Validate the whole batch before producing any trash side effect.
    for (const target of targets) await checkTarget(realRoot, target);
  } catch (err) {
    throw new KydogError('fs.access_denied', `无法校验废纸篓请求：${errorDetail(err)}`, err);
  }

  const result: TrashFilesResult = { trashed: [], failed: [] };
  for (const target of targets) {
    try {
      // Local concurrent replacement is possible after preflight. Recheck before each shell call;
      // shell.trashItem still has a native TOCTOU boundary, so this is not a batch transaction.
      await checkTarget(realRoot, target);
      await shell.trashItem(target);
      result.trashed.push(target);
    } catch (err) {
      result.failed.push({ path: target, error: serializeError(new KydogError(
        'fs.write_failed', `无法将 ${target} 移至废纸篓：${errorDetail(err)}`, err,
      )) });
    }
  }
  return result;
}
