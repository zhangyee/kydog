import { promises as fs } from 'node:fs';
import { atomicWrite } from './atomicWrite';
import * as paths from './paths';
import type { IndexFile } from '../../shared/types';
import { logger } from '../log';

export function defaultIndex(): IndexFile {
  return { schemaVersion: 1, projects: [], threads: [] };
}

export async function loadIndex(): Promise<IndexFile> {
  try {
    const raw = await fs.readFile(paths.INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw) as IndexFile;
    if (parsed && parsed.schemaVersion === 1 && Array.isArray(parsed.projects) && Array.isArray(parsed.threads)) {
      return parsed;
    }
    logger.warn('persist.indexFile', 'load failed; returning defaults', { reason: 'shape mismatch' });
    return defaultIndex();
  } catch (err) {
    logger.warn('persist.indexFile', 'load failed; returning defaults', { err: String(err) });
    return defaultIndex();
  }
}

export async function saveIndex(value: IndexFile): Promise<void> {
  await atomicWrite(paths.INDEX_FILE, JSON.stringify(value, null, 2));
}

// 同一进程里的索引读-改-写必须排队。atomicWrite 只保证单次文件替换完整；两个
// 调用同时读到旧快照时，后写入的仍会把先写入的新对话覆盖掉。
let indexQueue: Promise<void> = Promise.resolve();

export function withIndexLock<T>(work: () => Promise<T>): Promise<T> {
  const result = indexQueue.then(work);
  indexQueue = result.then(() => {}, () => {});
  return result;
}
