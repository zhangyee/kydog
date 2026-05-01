// src/main/llm/kydogAuthBackend.ts
import type { SettingsService } from '../settings/settingsService';
import type { SettingsFile, AuthBlob } from '../../shared/types';

// pi 的 AuthStorageBackend 接口形状（从 dist d.ts 抄；不直接 import 避免运行时依赖图）
type LockResult<T> = { result: T; next?: string };
export interface AuthStorageBackend {
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class KydogAuthStorageBackend implements AuthStorageBackend {
  constructor(private readonly svc: SettingsService) {}

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    return this.svc.withLockSync((settings) => {
      const blobStr = JSON.stringify(settings.llm.auth ?? {});
      const { next, result } = fn(blobStr);
      if (next === undefined || next === blobStr) return { result };
      const parsed = JSON.parse(next) as AuthBlob;     // 失败抛错给上层
      const nextSettings: SettingsFile = {
        ...settings,
        llm: { ...settings.llm, auth: parsed },
      };
      return { result, next: nextSettings };
    });
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    return this.svc.withLock(async (settings) => {
      const blobStr = JSON.stringify(settings.llm.auth ?? {});
      const { next, result } = await fn(blobStr);
      if (next === undefined || next === blobStr) return { result };
      const parsed = JSON.parse(next) as AuthBlob;
      const nextSettings: SettingsFile = {
        ...settings,
        llm: { ...settings.llm, auth: parsed },
      };
      return { result, next: nextSettings };
    });
  }
}
