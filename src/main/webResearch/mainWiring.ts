import type { App } from 'electron';
import { logger } from '../log';

/** Call shutdown synchronously: its first step revokes every result before browser teardown. */
export function installWebResearchQuitWiring(app: App, shutdown: () => Promise<void>): void {
  let draining = false, drained = false;
  app.on('before-quit', event => {
    if (drained) return;
    event.preventDefault();
    if (draining) return;
    draining = true;
    let work: Promise<void>;
    try { work = shutdown(); } catch (error) { work = Promise.reject(error); }
    void work.catch(error => { logger.error('webResearch', 'shutdown failed', { err: String(error) }); })
      .finally(() => { drained = true; app.quit(); });
  });
}
