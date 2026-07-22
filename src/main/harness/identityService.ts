import path from 'node:path';
import chokidar from 'chokidar';
import * as paths from '../persist/paths';
import { readFrontmatterName } from './frontmatter';
import { DEFAULT_USER_NAME, DEFAULT_AGENT_NAME } from './names';
import { logger } from '../log';
import type { Identity } from '../../shared/types';

export async function getIdentity(dir: string = paths.ROOT): Promise<Identity> {
  const [agentName, userName] = await Promise.all([
    readFrontmatterName(path.join(dir, 'SOUL.md')),
    readFrontmatterName(path.join(dir, 'USER.md')),
  ]);
  if (agentName === null) logger.info('harness.identity', 'SOUL name fallback', {});
  if (userName === null) logger.info('harness.identity', 'USER name fallback', {});
  return { userName: userName ?? DEFAULT_USER_NAME, agentName: agentName ?? DEFAULT_AGENT_NAME };
}

/** chokidar 监听 ~/.kydog/ 目录并过滤两文件，覆盖 add/change/unlink（spec §6）。 */
export function startIdentityWatcher(onChange: (id: Identity) => void, dir: string = paths.ROOT): () => void {
  const watcher = chokidar.watch(dir, { depth: 0, ignoreInitial: true });
  let timer: NodeJS.Timeout | null = null;
  const trigger = (p: string) => {
    const base = path.basename(p);
    if (base !== 'SOUL.md' && base !== 'USER.md') return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void getIdentity(dir).then(onChange); }, 200);
  };
  watcher.on('add', trigger).on('change', trigger).on('unlink', trigger);
  watcher.on('error', (err) => logger.warn('harness.identity', 'watch error', { err: String(err) }));
  return () => { if (timer) clearTimeout(timer); void watcher.close(); };
}
