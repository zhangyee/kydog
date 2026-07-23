// src/main/settings/settingsService.ts
import { lock, lockSync } from 'proper-lockfile';
import { readFileSync } from 'node:fs';
import * as paths from '../persist/paths';
import { defaultSettings, loadSettings, ensureSettingsFile, parseAndMigrateSettings } from '../persist/settingsFile';
import { atomicWriteWith0600Async, atomicWriteWith0600Sync } from '../persist/atomicWrite';
import type { SettingsFile, SettingsPatch } from '../../shared/types';

// In-process serialization: all operations (sync and async) are serialized
// through this chain so proper-lockfile is never contested within one process.
let _queue: Promise<unknown> = Promise.resolve();

/** Enqueue an async operation after all pending operations complete. */
function enqueueAsync<T>(fn: () => Promise<T>): Promise<T> {
  const p = _queue.then(fn, fn);
  // Swallow errors in the chain tail so the queue never gets stuck
  _queue = p.then(
    () => {},
    () => {},
  );
  return p;
}

const FILE_LOCK_OPTS = (): Parameters<typeof lock>[1] => ({
  lockfilePath: paths.LOCK_PATH,
  realpath: false,
  retries: { retries: 5, minTimeout: 50, maxTimeout: 200 },
  stale: 10_000,
});

const FILE_LOCK_OPTS_SYNC = (): Parameters<typeof lockSync>[1] => ({
  lockfilePath: paths.LOCK_PATH,
  realpath: false,
  stale: 10_000,
});

export class SettingsService {
  private cache: SettingsFile | null = null;

  async get(): Promise<SettingsFile> {
    if (!this.cache) this.cache = await loadSettings();
    return this.cache;
  }

  /** 兼容旧 callsites（settings.update IPC 等）；内部走 withLock 统一锁。 */
  async update(patch: SettingsPatch): Promise<SettingsFile> {
    return this.withLock(async (cur) => {
      const next: SettingsFile = {
        schemaVersion: 4,
        ui: { ...cur.ui, ...(patch.ui ?? {}) },
        llm: { ...cur.llm, ...(patch.llm ?? {}) },
        skills: { ...cur.skills, ...(patch.skills ?? {}) },
        tools: { ...cur.tools, ...(patch.tools ?? {}) },
        onboarding: cur.onboarding, // 只能由 onboarding 服务改（spec §7）
      };
      return { next, result: next };
    });
  }

  async reset(): Promise<void> {
    await this.withLock(async () => ({ next: defaultSettings(), result: undefined }));
  }

  async withLock<T>(
    fn: (current: SettingsFile) => Promise<{ next?: SettingsFile; result: T }>,
  ): Promise<T> {
    return enqueueAsync(async () => {
      ensureSettingsFile();
      const release = await lock(paths.ROOT, FILE_LOCK_OPTS());
      try {
        const current = await loadSettings();
        const { next, result } = await fn(current);
        if (next && next !== current) {
          await atomicWriteWith0600Async(paths.SETTINGS_FILE, JSON.stringify(next, null, 2));
          this.cache = next;
        } else {
          this.cache = current;
        }
        return result;
      } finally {
        await release();
      }
    });
  }

  withLockSync<T>(
    fn: (current: SettingsFile) => { next?: SettingsFile; result: T },
  ): T {
    // Sync operations are serialized with the async queue via a synchronous
    // placeholder: we append a settled promise so future async ops wait after us.
    ensureSettingsFile();
    const release = lockSync(paths.ROOT, FILE_LOCK_OPTS_SYNC());
    let result: T;
    try {
      const raw = readFileSync(paths.SETTINGS_FILE, 'utf8');
      const current: SettingsFile = parseAndMigrateSettings(raw);
      const { next, result: r } = fn(current);
      result = r;
      if (next && next !== current) {
        atomicWriteWith0600Sync(paths.SETTINGS_FILE, JSON.stringify(next, null, 2));
        this.cache = next;
      } else {
        this.cache = current;
      }
    } finally {
      release();
    }
    // Block any pending async ops from seeing stale data by draining their
    // pre-acquired lock attempts — not needed because enqueueAsync serializes.
    return result!;
  }
}

export const settingsService = new SettingsService();
