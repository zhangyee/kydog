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
/** CARSI 机构清单的落盘副本（fsso.cnki.net 抓不到时的回落来源）。
 *  放 CACHE_DIR 而不是 STAGING_DIR：main.ts 启动时会清空 staging，而这份要跨重启活着 ——
 *  它存在的唯一理由就是「这次抓不到，至少还有上次那份」。里面全是公开的机构名与
 *  entityID，没有任何用户数据，与 kydog.json 分开放。 */
export const IDP_LIST_CACHE_FILE = path.join(CACHE_DIR, 'idp-list.json');
export const SOUL_FILE = path.join(ROOT, 'SOUL.md');
export const USER_FILE = path.join(ROOT, 'USER.md');
export const AGENTS_FILE = path.join(ROOT, 'AGENTS.md');
export const SEED_MANIFEST_FILE = path.join(ROOT, '.onboarding-seed.json');
export const INSTALL_ID_FILE = path.join(ROOT, 'install-id');
export const LAST_BEACON_FILE = path.join(ROOT, 'last-beacon');

export function sessionsDirFor(projectPath: string): string {
  return path.join(SESSIONS_DIR, cwdHash(projectPath));
}

export function sessionFileFor(projectPath: string, threadId: string): string {
  return path.join(sessionsDirFor(projectPath), `${threadId}.jsonl`);
}
