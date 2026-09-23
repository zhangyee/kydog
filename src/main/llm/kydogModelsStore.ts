// src/main/llm/kydogModelsStore.ts
import { readFile } from 'node:fs/promises';
import type { ModelsStore, ModelsStoreEntry } from '@earendil-works/pi-ai';
import { atomicWrite } from '../persist/atomicWrite';

// `import type` 转译时整句擦除，不进运行时依赖图 —— 与 kydogAuthBackend.ts 同一个理由。

/** 写入者版本落在条目里的这个键上。pi 不认识它，`{...stored}` 会原样保留。 */
const STAMP_KEY = 'kydogStampedWith';

function stampOf(entry: ModelsStoreEntry): string | undefined {
  const v = (entry as unknown as Record<string, unknown>)[STAMP_KEY];
  return typeof v === 'string' ? v : undefined;
}

/**
 * pi 远端模型目录的落盘缓存（`ModelRuntime.create({ modelsStore })` 的那个口子）。
 *
 * 自己实现而不是用 pi 的 `FileModelsStore`，为的是能**读**这份缓存：它是「这个 provider
 * 现在还在售哪些模型」唯一的协议层来源。pi 把远端目录按 id upsert 合并进内置静态目录
 * （`remote-catalog-provider.js` 的 `mergeModels`），所以静态目录里的旧 id 永远不会消失——
 * 退役的模型会一直留在选单里，会话可以一直钉着它，直到某天服务端拒绝这个 id 才在发送时炸。
 * `liveModelIds()` 把远端那份清单交给 `llmService.entryFor` 去过滤。pi 的 `FileModelsStore`
 * 没从包根导出，拿不到。
 *
 * 顺带把存放位置从 pi 的 `getAgentDir()` 默认值变成显式的 `<ROOT>/agent`，与 `modelsPath`
 * 同一个口径（见 `buildModelRuntimeOptions` 上的注释）。
 */
export class KydogModelsStore implements ModelsStore {
  /**
   * 整份文件的内存镜像。pi 的写全部经过这里，所以它一直是最新的；外部改这个文件不会被
   * 看见（单实例应用，只有 pi 一个写者）。null = 还没读过。
   */
  private cache: Record<string, ModelsStoreEntry> | null = null;

  /**
   * @param stamp 写入者的身份，今天是 KyDog 的版本号。见 `liveModelIds` 第 2 条。
   */
  constructor(private readonly path: string, private readonly stamp: string) {}

  private async all(): Promise<Record<string, ModelsStoreEntry>> {
    if (this.cache) return this.cache;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, 'utf-8'));
      this.cache = parsed && typeof parsed === 'object' ? (parsed as Record<string, ModelsStoreEntry>) : {};
    } catch {
      // 文件不在、或内容坏了 —— 当成没有缓存。pi 会重新拉一次，拉到就覆盖写回去。
      this.cache = {};
    }
    return this.cache;
  }

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    return (await this.all())[providerId];
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    // 先换掉 cache 再 await 落盘：两次并发的 write 在同一个 tick 里各自读到的都是上一次
    // 已经合并过的对象，不会互相覆盖（单线程，读改写之间没有 await）。
    // 每一次写都盖上写入者的版本。pi 的 304 分支是 `{...stored, checkedAt}`，会把这个字段
    // 原样带过去；它重新拉到目录时整条替换，于是又经过这里重新盖一次 —— 两条路都对。
    const next = { ...(await this.all()), [providerId]: { ...entry, [STAMP_KEY]: this.stamp } };
    this.cache = next;
    await atomicWrite(this.path, JSON.stringify(next));
  }

  async delete(providerId: string): Promise<void> {
    const next = { ...(await this.all()) };
    delete next[providerId];
    this.cache = next;
    await atomicWrite(this.path, JSON.stringify(next));
  }

  /**
   * 远端目录给过的这个 provider 的模型 id。远端是按 provider 整份给的，所以拉到过就是
   * 这个 provider 的权威清单。**下面任何一条不成立就返回 `undefined`，调用方此时一个都
   * 不许过滤** —— 没有清单不等于清单是空的：
   *
   * 1. 这个 provider 从没拉到过（离线、刷新失败、pi.dev 上没有它）；
   * 2. 缓存不是**这个版本的 KyDog** 写下的（`stampedWith`）。pi 判缓存是否过期用的是
   *    `lastModified <= 内置静态目录的生成时间`（remote-catalog-provider.js 的
   *    `remoteModels`），而那个时间戳 pi-ai 没导出到包根、deep import 被 exports 挡掉，
   *    我们读不到。于是换一个自己能守的等价条件：KyDog 升级会换一份 pi、也就换一份静态
   *    目录，所以只认「这一版 KyDog 亲眼见 pi 写过」的缓存。升级后第一次成功刷新之前
   *    （pi 的 4 小时新鲜窗口内可能不发请求）不过滤 —— 宁可多列一个退役 id，也不要按一份
   *    pi 自己已经丢弃的缓存把在售模型藏起来，那种分歧是静默的。
   * 3. `lastModified` 不是正数。pi 在 404/501 上会写回 `lastModified: 0` 表示「这个
   *    provider 没有远端目录」，那份 models 是旧的，不能当权威清单。
   */
  async liveModelIds(providerId: string): Promise<ReadonlySet<string> | undefined> {
    const entry = await this.read(providerId);
    if (!entry?.models?.length) return undefined;
    if (stampOf(entry) !== this.stamp) return undefined;
    if (typeof entry.lastModified !== 'number' || entry.lastModified <= 0) return undefined;
    return new Set(entry.models.map((m) => m.id));
  }
}
