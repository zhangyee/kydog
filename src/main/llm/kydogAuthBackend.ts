// src/main/llm/kydogAuthBackend.ts
import type { SettingsService } from '../settings/settingsService';
import type { SettingsFile, AuthBlob } from '../../shared/types';

// pi-ai 的 CredentialStore 接口形状（从 dist/auth/types.d.ts 抄；不直接 import 避免
// 把 pi 拖进这个模块的静态依赖图 —— 其余模块都走 dynamic import）。
export type Credential = AuthBlob[string];
export type CredentialInfo = { providerId: string; type: Credential['type'] };

export interface CredentialStore {
  read(providerId: string): Promise<Credential | undefined>;
  list(): Promise<readonly CredentialInfo[]>;
  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined>;
  delete(providerId: string): Promise<void>;
}

/**
 * 把 KyDog 的 `settings.llm.auth` 暴露成 pi-ai 的 CredentialStore。
 *
 * 语义差异（相对旧的 AuthStorageBackend）：旧接口对整个 auth blob 加一把锁、收发 JSON
 * 字符串；新接口按 providerId 收发结构化 Credential。SettingsService 的锁是整文件级的，
 * 比「per-provider 互斥」更粗，但满足要求 —— pi 只要求同一 provider 的写不能交错。
 */
export class KydogCredentialStore implements CredentialStore {
  constructor(private readonly svc: SettingsService) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return (await this.svc.get()).llm.auth[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const auth = (await this.svc.get()).llm.auth;
    return Object.entries(auth).map(([providerId, cred]) => ({ providerId, type: cred.type }));
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.svc.withLock(async (settings) => {
      const current = settings.llm.auth[providerId];
      const next = await fn(current);
      if (next === undefined) return { result: current };
      const nextAuth: AuthBlob = { ...settings.llm.auth, [providerId]: next };
      const nextSettings: SettingsFile = { ...settings, llm: { ...settings.llm, auth: nextAuth } };
      return { result: next, next: nextSettings };
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.svc.withLock(async (settings) => {
      if (!(providerId in settings.llm.auth)) return { result: undefined };
      const nextAuth: AuthBlob = { ...settings.llm.auth };
      delete nextAuth[providerId];
      const nextSettings: SettingsFile = { ...settings, llm: { ...settings.llm, auth: nextAuth } };
      return { result: undefined, next: nextSettings };
    });
  }
}
