import path from 'node:path';
import os from 'node:os';
import { cwdHash } from './cwdHash';

export const ROOT = path.join(os.homedir(), '.kydog');
export const INDEX_FILE = path.join(ROOT, 'index.json');
export const SETTINGS_FILE = path.join(ROOT, 'kydog.json');
export const LOCK_PATH = path.join(ROOT, '.kydog.json.lock');
export const SESSIONS_DIR = path.join(ROOT, 'sessions');
export const LOGS_DIR = path.join(ROOT, 'logs');
export const CACHE_DIR = path.join(ROOT, '.cache');
export const STAGING_DIR = path.join(CACHE_DIR, 'staging');

export function sessionsDirFor(projectPath: string): string {
  return path.join(SESSIONS_DIR, cwdHash(projectPath));
}

export function sessionFileFor(projectPath: string, threadId: string): string {
  return path.join(sessionsDirFor(projectPath), `${threadId}.jsonl`);
}
