import { promises as fs } from 'node:fs';
import { atomicWrite } from './atomicWrite';
import * as paths from './paths';
import type { IndexFile } from '../../shared/types';

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
    return defaultIndex();
  } catch {
    return defaultIndex();
  }
}

export async function saveIndex(value: IndexFile): Promise<void> {
  await atomicWrite(paths.INDEX_FILE, JSON.stringify(value, null, 2));
}
