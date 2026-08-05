// src/main/llm/kydogAuthBackend.ts
import type { CredentialStore, Credential as PiCredential } from '@earendil-works/pi-ai';
import type { SettingsService } from '../settings/settingsService';
import type { SettingsFile, AuthBlob } from '../../shared/types';

// 这里直接 import type pi 的 CredentialStore：`import type` 转译时整句擦除，不进运行时
// 依赖图，所以「其余模块走 dynamic import」的约束不受影响（providerRegistry.ts 的
// `typeof import(...)` 同理）。
//
// 凭证的数据形状仍用 KyDog 自己的 AuthBlob，不复用 pi 的 Credential：shared/types.ts
// 是主/渲染进程共用的，不该把 pi 拖进渲染侧。代价是 AuthBlob 必须跟 pi 的 Credential
// 保持一致 —— 由下面的 _authBlobMatchesPi 在编译期钉住。
export type Credential = AuthBlob[string];
export type CredentialInfo = { providerId: string; type: Credential['type'] };

/** 双向 extends 的精确相等；单向 assignable 挡不住 pi 加字段/放宽字段。 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// pi 升级改了 Credential（加字段、改可选性、动 union 分支），先炸在这一行；否则
// 全部调用点都是 `as any`，下游没有任何东西会发现形状对不上了。
const _authBlobMatchesPi: Exact<Credential, PiCredential> = true;

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
