// src/main/settings/settingsService.ts
import { lock } from 'proper-lockfile';
import * as paths from '../persist/paths';
import {
  defaultSettings, readSettings, ensureSettingsFile,
  sanitizeBrowserWidth, sanitizeInstitution, checkInstitution, CURRENT_SCHEMA_VERSION,
} from '../persist/settingsFile';
import type { SettingsRead } from '../persist/settingsFile';
import { atomicWriteWith0600Async } from '../persist/atomicWrite';
import { KydogError } from '../../shared/errors';
import type { InstitutionPublic, SettingsFile, SettingsFileForRenderer, SettingsHealth, SettingsPatch } from '../../shared/types';

/**
 * 落盘记录 → 渲染层可见的那份。**唯一一处做这件事的地方**：`toRendererSettings` 与
 * `institutionService.get/save` 都调它，不各写一遍 —— 两份投影漂开的时候，漏掉的
 * 那一份就是密文的出口，而 tsc 不会说话（两边都是「少一个字段的对象字面量」，各自合法）。
 */
export function toInstitutionPublic(inst: SettingsFile['institution']): InstitutionPublic {
  if (inst === null) return null;
  return {
    name: inst.name,
    entityID: inst.entityID,
    username: inst.username,
    // 只回「有没有」这一个比特。空串 = 配了机构与账号但还没设密码。
    hasPassword: inst.passwordEnc !== '',
    confirmedLogins: inst.confirmedLogins,
  };
}

/**
 * 主进程 → 渲染层那道收口。**唯一的作用是把 passwordEnc 留在这一侧。**
 *
 * app.bootstrap / settings.get / settings.update / locale.set 四条都回整份 settings，
 * 从前它们回的是 SettingsFile，于是每次启动主进程就把密文交给了 useSettingsStore ——
 * 而 institution.revealPassword 那道「显式往返」的设计意图正是不让它自动过去。
 *
 * 靠调用点自觉删字段守不住（四条路，新增一条就会漏），所以让类型说了算：
 * InstitutionRecord 赋不进 InstitutionPublic（少一个 hasPassword），漏了转换 tsc 就红。
 */
export function toRendererSettings(s: SettingsFile): SettingsFileForRenderer {
  return { ...s, institution: toInstitutionPublic(s.institution) };
}

/**
 * 落盘前的最后一道判据，写口（`updateInstitution`）与 `confirmLogin` 共用。
 * **消息里带上真实原因** —— 从前无论什么原因都只说「缺少机构名 / entityID / 用户名」，
 * 于是「密文忘了 toString('base64')」这种事在界面上会被说成一句完全无关的话。
 */
function requireValidInstitution(v: NonNullable<SettingsFile['institution']>): NonNullable<SettingsFile['institution']> {
  const c = checkInstitution(v);
  if (!c.ok) throw new KydogError('settings.invalid', `机构账号无法保存：${c.why}`);
  return c.record;
}

// In-process serialization: all operations are serialized through this chain
// so proper-lockfile is never contested within one process.
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

/**
 * `SettingsRead` → 给渲染层看的那一档。
 *
 * `absent` 并进 `ok`：文件真的不在时按默认设置起步是**正常开局**（首次运行就是这样），
 * 没有什么要告诉用户的。要告诉用户的是另外两种：东西被留档了，或者盘上那份读不出来。
 *
 * 备份**只带文件名不带路径** —— 路径里有用户名，而用户在自己的 `~/.kydog/` 里
 * 按文件名就找得到。
 */
function toHealth(read: SettingsRead): SettingsHealth {
  if (read.kind === 'quarantined') {
    return { kind: 'quarantined', backup: read.backup.slice(read.backup.lastIndexOf('/') + 1) };
  }
  if (read.kind === 'unreadable') return { kind: 'unreadable', why: read.why };
  return { kind: 'ok' };
}

export class SettingsService {
  private cache: SettingsFile | null = null;
  private health: SettingsHealth = { kind: 'ok' };

  async get(): Promise<SettingsFile> {
    if (!this.cache) {
      const read = await readSettings();
      this.health = toHealth(read);
      this.cache = read.settings;
    }
    return this.cache;
  }

  /**
   * 上一次读盘的判据。`app.bootstrap` 拿它去点亮设置页的横幅 ——
   * **不额外读一次盘**：多读一次就可能读到与当时不同的状态，横幅说的就不是
   * 「你现在用的这份设置是怎么来的」了。
   */
  settingsHealth(): SettingsHealth { return this.health; }

  /** 兼容旧 callsites（settings.update IPC 等）；内部走 withLock 统一锁。 */
  async update(patch: SettingsPatch): Promise<SettingsFile> {
    return this.withLock(async (cur) => {
      const ui = { ...cur.ui, ...(patch.ui ?? {}) };
      const next: SettingsFile = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        // browserWidth 走与读路径同一个 sanitize。不对称的代价很具体：渲染层拖拽时
        // 算错一次（比如 0）就当场进 cache 与磁盘，同一次会话里 browserService 按
        // scale = W/1280 = 0 调 setDeviceMetricsOverride，页面渲染塌掉；重启后
        // parseAndMigrateSettings 又把它拉回默认 —— 现象是「重启就好了」，无法稳定复现。
        ui: { ...ui, browserWidth: sanitizeBrowserWidth(ui.browserWidth) },
        llm: { ...cur.llm, ...(patch.llm ?? {}) },
        skills: { ...cur.skills, ...(patch.skills ?? {}) },
        tools: { ...cur.tools, ...(patch.tools ?? {}) },
        research: { ...cur.research, ...(patch.research ?? {}) },
        // 只能由 institutionService 经 updateInstitution 改。允许走 patch 就等于开了一条
        // 把明文密码直接写进 passwordEnc 的路 —— 绕过 safeStorage，且不会报错。
        institution: cur.institution,
        updates: cur.updates,     // 只能由更新服务改（spec §7）
        telemetry: cur.telemetry, // 只能由 telemetryService 改（见 telemetry/telemetryService.ts）
        onboarding: cur.onboarding, // 只能由 onboarding 服务改（spec §7）
      };
      return { next, result: next };
    });
  }

  /**
   * 把机构账号整条抹掉。**只清，不写** —— 收不下任何记录，所以它开不出一条
   * 「凭空塞一个 passwordEnc」的路。
   *
   * 从前这里是 `setInstitution(v: SettingsFile['institution'])`：它照单全收任何字符串
   * 当 `passwordEnc`，既不问钥匙串、也无从分辨密文与明文（持久化层没有 safeStorage，
   * 而按字节形状去猜是启发式，不是判据）。真正那道闸只可能住在
   * `institutionService.nextPasswordEnc`（加密与「要不要加密」在同一处）。
   * 当时唯一的非测试调用方就是 `institutionService.clear()`，传的是 `null` ——
   * 于是把它收成「只清」：**过判据的那个口只剩 `updateInstitution`**，
   * 而那个口的调用方只有 `institutionService.save`。
   *
   * 这道收窄减少的是「有人绕开 institutionService 手拼一条记录」的表面积，
   * 它**不等于**「明文写不进来」（`updateInstitution` 照样收得下任何字符串），
   * 也**不等于**「只剩一个写口」—— 下面 `withLock` 是 public 的逃生口，经它写
   * `institution` 会跳过 `checkInstitution`（见它自己的 JSDoc）。
   */
  async clearInstitution(): Promise<void> {
    await this.withLock(async (cur) => ({ next: { ...cur, institution: null }, result: undefined }));
  }

  /**
   * **锁内**对机构记录做一次 read-modify-write，落盘前过 `checkInstitution`。
   * **落一条机构记录唯一一个过判据的口**，而它唯一的非测试调用方是
   * `institutionService.save`（抹掉整条走 `clearInstitution`）。**不是唯一的写口** ——
   * `withLock` 是 public 的逃生口，经它写 `institution` 会跳过下面这道
   * `checkInstitution`（那条 JSDoc 里写着，本文件里就有）。
   *
   * **写路径与读路径共用 `checkInstitution`**，两头对齐的方式是「写入时就拒绝」而不是
   * 「读取时容忍半条」。理由是读路径那条注释本来就成立：一条 name/entityID 为空的记录
   * 在设置页上看起来像「配过了」，而 browser_login 的判据要到运行时才失败。所以宁可
   * 当场报错，也不要「保存成功、界面显示已选中、重启后整条消失且没有任何提示」。
   * 落盘的是判据归一之后的值，不是回调的返回值：这样「存进去什么、重启后读回什么」
   * 是同一件事；confirmedLogins 里 entityID 不符的条目在这里就被剔除，不留到读路径去。
   *
   * 为什么不能让调用方自己 `get()` → 拼一条 → 写回：那两步之间没有锁。
   * `institution.save` 的语义里「密码省略 = 沿用已存的那份密文」「confirmedLogins 省略 =
   * 保留」——**两样都要读旧记录**。锁外读到的旧记录与真正落盘的那一刻之间隔着一次
   * await，同一条 `confirmLogin` 的 JSDoc 里已经把这条路的后果写清楚了（用户在这中间
   * 改了学校，随后整条旧记录被原样写回，零错误）。所以读与写必须在同一把锁里。
   *
   * 回调是**同步**的：加密是同步调用，锁内不需要也不应该再 await 任何东西。回调抛错
   * 就整次不写盘（锁照常释放），于是「钥匙串不可用」是一次干净的拒绝，不会留下半条记录。
   */
  async updateInstitution(
    fn: (current: SettingsFile['institution']) => SettingsFile['institution'],
  ): Promise<SettingsFile['institution']> {
    return this.withLock<SettingsFile['institution']>(async (cur) => {
      const desired = fn(cur.institution);
      const normalized = desired === null ? null : requireValidInstitution(desired);
      return { next: { ...cur, institution: normalized }, result: normalized };
    });
  }

  /**
   * 记下「这个 entityID 的登录页就是这个 origin」。**刻意收两个标量而不是整条记录。**
   *
   * confirmedLogins 的追加只发生在「问过用户之后」，而问这一下要花好几秒。如果这里
   * 收整条记录，2b 唯一写得出来的调用就是：
   *
   * ```ts
   * const cur = await settingsService.get();            // 锁外，弹框之前的快照
   * // …弹确认对话框，用户想了十秒…
   * await settingsService.updateInstitution(() => ({ ...cur.institution!, confirmedLogins }));
   * ```
   *
   * 这十秒里用户在设置页把学校从北大改成了清华，上面那行随后把**整条旧记录**原样写回：
   * name / entityID / username / passwordEnc 全退回北大那份。sanitizeInstitution 一句话都
   * 不会说 —— 它比的是同一个对象内部的 entityID，当然相符。用户看到的现象是「刚改的
   * 学校自己变回去了」，零错误。
   *
   * 所以 read-modify-write 必须在锁内做，而且这里只允许改 confirmedLogins 这一个字段。
   * 锁内读到的记录不是当初问用户的那条（改了学校，或整条被删了）→ **放弃这次确认并返回
   * false**，不去猜用户的意思：代价只是下次多问一次，而猜错就是把清华的密码填进北大的
   * 统一身份认证页。
   *
   * 反过来的方向（把一次确认作废）不走这里，走 `institution.save` 的 `confirmedLogins: []`。
   */
  async confirmLogin(entityID: string, origin: string): Promise<boolean> {
    return this.withLock<boolean>(async (cur) => {
      const inst = cur.institution;
      if (inst === null || inst.entityID !== entityID) return { result: false };
      // **追加，不覆盖。** 覆盖的后果正是本次要修的那个毛病：学校的登录流程在两个
      // origin 之间跳转时，两条确认互相覆盖，用户被来回问，没完。
      // 已经有了就不动（`checkLoginHost` 那一侧比的是归一后的 origin，而这里收到的
      // 已经是 `canonicalOrigin` 的产物，所以直接按字符串去重就够）。
      const already = inst.confirmedLogins.some((c) => c.origin === origin);
      const confirmedLogins = already
        ? inst.confirmedLogins
        : [...inst.confirmedLogins, { entityID, origin }];
      const next = sanitizeInstitution({ ...inst, confirmedLogins });
      // 空 origin 之类会被 sanitize 悄悄剔掉，那就成了「记录里没有这一条」——
      // 与「确认失败」在调用方眼里长得一样。宁可当场报错。
      if (next === null || !next.confirmedLogins.some((c) => c.origin === origin)) {
        throw new KydogError('settings.invalid', '登录确认缺少 entityID 或 origin，无法记录');
      }
      return { next: { ...cur, institution: next }, result: true };
    });
  }

  /** telemetry 只能由 telemetryService 经此方法改，故不在 SettingsPatch 中
   *  —— 与 updates 同样的约定。 */
  async setTelemetry(t: SettingsFile['telemetry']): Promise<void> {
    await this.withLock(async (cur) => ({ next: { ...cur, telemetry: t }, result: undefined }));
  }

  async reset(): Promise<void> {
    await this.withLock(async () => ({ next: defaultSettings(), result: undefined }));
  }

  /**
   * 队列 + 文件锁里做一次 read-modify-write。回调拿到的 `current` 是**锁内刚从磁盘读回来**
   * 的那一份，不是 cache —— 这正是它存在的理由。
   *
   * **注意：经它写 institution 会跳过 sanitizeInstitution。** `next` 是什么就落什么盘，
   * 于是「写路径与读路径共用同一个判据」这条不变式只在 updateInstitution / confirmLogin
   * 这两个入口上成立。要动 institution 就走那两个，别在这里手拼一条记录：读路径会因为
   * name / entityID / username 缺一个而把整条丢回 null，现象是「保存成功、重启后消失」。
   */
  async withLock<T>(
    fn: (current: SettingsFile) => Promise<{ next?: SettingsFile; result: T }>,
  ): Promise<T> {
    return enqueueAsync(async () => {
      ensureSettingsFile();
      const release = await lock(paths.ROOT, FILE_LOCK_OPTS());
      try {
        // **读不出来就一个字都不写。** 这里拿的是锁内最新的磁盘状态，而读失败时
        // `settings` 是一份默认设置 —— 照写就是拿默认值把一份好文件盖掉，里面有
        // 机构密码密文与 LLM API key，既没备份也没提示（见 settingsFile 的 SettingsRead）。
        // 宁可这一次改动失败：报错用户看得见，静默丢凭据看不见。
        // 判据是 errno（EACCES / EBUSY / EIO…），不是「读回来的像不像默认设置」——
        // 后者分不出「文件真的不在」和「文件还在、只是没读出来」。
        const read = await readSettings();
        this.health = toHealth(read);
        if (read.kind === 'unreadable') {
          throw new KydogError('settings.write_failed',
            `设置文件这一次读不出来（${read.why}），为免把已有的设置和凭据覆盖掉，这次改动没有写盘。`
            + '稍后再试一次；一直如此就检查一下 ~/.kydog/kydog.json 的权限与占用。');
        }
        const current = read.settings;
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

}

export const settingsService = new SettingsService();
