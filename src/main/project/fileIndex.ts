import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { isListedName } from './listing';
import { buildPathIndex, searchPathIndex, type PathIndex } from '../../shared/fuzzyPath';
import { broadcaster } from '../ipc/broadcaster';
import { logger } from '../log';

export type ReadDirFn = (dir: string) => Promise<Array<{ name: string; isDirectory: boolean }>>;

const realReadDir: ReadDirFn = async (dir) =>
  (await fsp.readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));

/**
 * 按文件树同一套规则（`isListedName`）列出项目里的全部文件，相对路径、`/` 分隔。
 *
 * **同一时间只有一个 `readdir` 在飞**：09-21 那次大项目把主进程的 fs 堵死，是因为同时挂了
 * 一整树的读；这里一层一层串着读，扫得慢一点，但不挤占 libuv 的线程池。不设文件数上限。
 * 读不了的目录跳过、其余照常。符号链接不跟进（`isDirectory()` 对它是 false），按文件列出，
 * 与文件树的显示一致，也不会绕进环里。
 */
export async function walkProjectFiles(root: string, readDir: ReadDirFn = realReadDir): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let entries: Awaited<ReturnType<ReadDirFn>>;
    try {
      entries = await readDir(rel === '' ? root : path.join(root, ...rel.split('/')));
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!isListedName(e.name)) continue;
      const child = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory) stack.push(child);
      else out.push(child);
    }
  }
  return out;
}

/**
 * `index` 在一趟扫完时建好（每条路径的小写串、深度、空查询的前 50 名），查询只扫一遍、不整体排序：
 * 查询跑在主进程上，100 万条路径时原来每次按键都要整体排序（空查询 2.7s），同 09-21 那次是一类卡死。
 */
type Entry = { index: PathIndex | null; scanning: Promise<void> | null };

export function createFileIndex(deps: {
  walk?: (root: string) => Promise<string[]>;
  onUpdated: (projectPath: string) => void;
}) {
  const walk = deps.walk ?? ((root: string) => walkProjectFiles(root));
  const byProject = new Map<string, Entry>();

  /** 同一项目同一时间只有一趟；进行中的再请求，拿到的就是那一趟。 */
  function rescan(projectPath: string): Promise<void> {
    let e = byProject.get(projectPath);
    if (!e) { e = { index: null, scanning: null }; byProject.set(projectPath, e); }
    if (e.scanning) return e.scanning;
    const entry = e;
    entry.scanning = walk(projectPath)
      .then(
        (files) => { entry.index = buildPathIndex(files); },
        (err) => { logger.warn('project', 'file index scan failed', { projectPath, err: String(err) }); },
      )
      .finally(() => { entry.scanning = null; deps.onUpdated(projectPath); });
    return entry.scanning;
  }

  function search(args: { projectPath: string; query: string; rescan?: boolean }): { items: { path: string }[]; indexed: boolean } {
    if (args.rescan) void rescan(args.projectPath);
    const index = byProject.get(args.projectPath)?.index;
    if (!index) return { items: [], indexed: false };
    return { items: searchPathIndex(index, args.query).map((p) => ({ path: p })), indexed: true };
  }

  return { search, rescan };
}

export const fileIndex = createFileIndex({
  onUpdated: (projectPath) => broadcaster.emit('project.fileIndexUpdated', { projectPath }),
});
