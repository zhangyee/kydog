import { safeStorage } from 'electron';
import { promises as fsp } from 'node:fs';
import * as paths from '../persist/paths';
import { atomicWrite } from '../persist/atomicWrite';
import { settingsService, SettingsService, toInstitutionPublic } from '../settings/settingsService';
import { parseIdpList } from '../browser/idpList';
import { KydogError } from '../../shared/errors';
import { logger } from '../log';
import type {
  IdpEntry, IdpListPublic, InstitutionPublic, InstitutionSaveArgs, SettingsFile,
} from '../../shared/types';

type InstitutionRecord = NonNullable<SettingsFile['institution']>;

/**
 * 机构账号服务：**整个特性里唯一直接碰用户密码的地方。**
 *
 * 三条不变式，逐条都有用例守：
 * 1. 密码只往一个方向流。落盘的永远是 `safeStorage` 密文的 base64；出得去的只有
 *    `InstitutionPublic`（`hasPassword` 一个比特），明文只在 `reveal()` 这一条显式
 *    往返上回一次。密文与明文都不进日志。
 *    **落盘记录只由这个模块写**：`settingsService` 那一侧收记录的口只剩
 *    `updateInstitution`（`clearInstitution` 只清不写），本模块之外没有别的写口。
 * 2. **钥匙串不可用就拒绝，不静默退回明文**（spec §4.6）。判据是「这一次要不要加密」，
 *    不是「钥匙串好不好」—— 不碰密码的保存（改学校、改学号、清密码）没有明文风险，
 *    一刀切拒绝只会让用户连学校都改不了。
 * 3. 读旧记录与写新记录在**同一把锁**里（`settingsService.updateInstitution`）。
 *    「密码省略 = 沿用已存的密文」「confirmedLogin 省略 = 保留」两样都要读旧记录，
 *    锁外读会撞上 `confirmLogin` 的 JSDoc 里写清楚的那条路：中间隔一次 await，
 *    整条旧记录被原样写回，零错误。
 */

/**
 * `safeStorage` 的端口。签名照 Electron 的原样（`encryptString` 回的是 **Buffer**）。
 *
 * 构造函数里它是**必填**、没有默认值：给一个「默认用真 safeStorage」的口子，等于
 * 让任何一个忘了注入的用例去弹系统钥匙串授权框。要真的那个，用文件末尾的单例。
 */
export type SafeStoragePort = {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
};

/**
 * CNKI 的 SP 清单端点。**不可注入** —— 没有任何运行时开关能改它（与 telemetry 的
 * `TELEMETRY_ORIGIN` 同一条规矩）。`federation=2` 是国内那份；`federation=1` 是
 * 另一份 90 条的国际清单，一期不拉。
 */
export const IDP_LIST_URL = 'https://fsso.cnki.net/idp/list?federation=2';

/**
 * 单次抓取的 deadline。
 *
 * 实测（2026-09-09，本机连 `fsso.cnki.net`，连抓 5 次，`curl -w time_total`）：
 * 0.256 / 0.265 / 0.248 / 0.256 / 0.258 秒，响应 76,565 字节。15 秒是它的约 57 倍，
 * 余量留给校园网与移动网络。取 15 秒而不是另拍一个数，是为了跟仓库里另一处同目的的
 * deadline（`telemetry/constants.ts` 的 `REQUEST_TIMEOUT_MS`）对齐。
 *
 * 上界不是可选的：不设时 `fetch` 可以一直挂着，而设置页的机构下拉就一直转圈。
 */
export const IDP_LIST_TIMEOUT_MS = 15_000;

/**
 * 响应体上限。
 *
 * 实测（2026-09-09）真实响应 **76,565 字节 / 1064 条**，且响应头里**没有
 * Content-Length**（`connection: close`，长度靠关连接界定）—— 所以「边读边数」是
 * 唯一挡得住的地方，光看响应头挡不住任何东西。
 *
 * 4 MiB ≈ 实测值的 55 倍。另一头也够宽：解析器最多留 `MAX_IDP_ENTRIES`（5000）条，
 * 按实测 76565/1064 ≈ 72 字节/条算约 360 KB，这个上限比「解析器可能用得上的最大量」
 * 还宽约 11 倍。挡的是端点异常返回几十万条时整份响应物化进主进程内存。
 */
export const MAX_IDP_LIST_BYTES = 4 * 1024 * 1024;

/** 落盘缓存的版本号。认不出来就当没有缓存 —— 半懂不懂地用比没有更糟。 */
const IDP_CACHE_VERSION = 1;

type IdpCache = { entries: IdpEntry[]; fetchedAt: string };

/**
 * 按**响应自己声明的 charset** 解码，而不是一律当 UTF-8。
 *
 * 这是 D15 那条债的修法，修在源头。`Response.text()` 永远按 UTF-8 解：接口按 GBK 发时
 * 它不报错，只是把每个汉字换成 U+FFFD —— 实测的现象是 1064 条乱码机构名原样进
 * `entries`、`skipped` 为空、全程零错误，用户在下拉里一个学校都认不出来，而我们以为
 * 一切正常。在下游按「有没有 U+FFFD」补救是 proxy；这里用的是协议层给的东西：
 *
 * 1. `Content-Type` 里的 `charset=` 参数 —— 有就按它解；
 * 2. 没有就按 UTF-8。这不是猜：RFC 8259 §8.1 规定不在封闭生态内交换的 JSON 文本
 *    必须用 UTF-8 编码，而 `application/json` 这个媒体类型压根没有定义 charset 参数。
 *    实测 2026-09-09，该端点回的正是 `content-type: application/json`（无 charset），
 *    字节是 UTF-8。
 *
 * `fatal: true` 是刻意的：字节在声明的编码里解不出来时**抛错**，而不是吐一串 U+FFFD。
 * 「读不懂」要能跟「读懂了」分开，而静默替换正是让它们长得一样的那一步。
 */
export function decodeByCharset(bytes: Uint8Array, contentType: string | null): string {
  const label = /;\s*charset\s*=\s*"?([^";]+?)"?\s*(?:;|$)/i.exec(contentType ?? '')?.[1]?.trim() || 'utf-8';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label, { fatal: true });
  } catch {
    throw new KydogError('institution.idp_list_invalid', `机构清单声明了一个不认识的编码：${label}`);
  }
  try {
    return decoder.decode(bytes);
  } catch {
    throw new KydogError('institution.idp_list_invalid',
      `机构清单的字节按它自己声明的编码（${label}）解不出来 —— 接口多半换了编码却没改 Content-Type`);
  }
}

const errText = (err: unknown): string => String((err as Error)?.message ?? err);

/**
 * 边读边数地把响应体收下来，**并且自己把 deadline 罩到正文读完为止**。
 *
 * 不用 `res.arrayBuffer()`：那是「先全物化，再回头看多大」，上限就白设了。实测该端点
 * 不发 Content-Length，所以也没有「先看响应头再决定读不读」这条捷径。
 *
 * 为什么这里要自己 race `signal` 而不是指望 `fetch` 把它接到响应体上：**接没接是实现的事，
 * 不是协议的承诺**。实测（2026-09-09，Node 24 / vitest）一个用 `new Response(new
 * ReadableStream(...))` 造出来的响应，`AbortController.abort()` 之后 `reader.read()`
 * **照常挂着不动** —— 信号只连到了那次 `fetch` 上。真机上 undici 会把信号接到体流上，
 * 但「响应头秒回、正文一直不来」在校园网的透明代理后面是常态，赌一个实现细节换来的是
 * 设置页的下拉一直转圈、且没有任何错误。所以自己 race。
 *
 * `res.body` 为 null 的那一支留给没有可读流的响应（HEAD、以及某些实现的空体）：
 * 那时 `arrayBuffer()` 拿到的东西本来就没有流可言，物化的代价是零。
 */
async function readCapped(res: Response, signal: AbortSignal, timeoutMs: number): Promise<Uint8Array> {
  const tooLarge = (n: number): KydogError => new KydogError('institution.idp_list_invalid',
    `机构清单响应超过 ${MAX_IDP_LIST_BYTES} 字节上限（已读 ${n}）`);

  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_IDP_LIST_BYTES) throw tooLarge(buf.byteLength);
    return buf;
  }

  let onAbort: (() => void) | null = null;
  const hitDeadline = new Promise<never>((_, reject) => {
    const fire = () => reject(new KydogError('institution.idp_list_unavailable',
      `机构清单撞了 ${timeoutMs} 毫秒的 deadline：响应头回来了，正文没读完`));
    if (signal.aborted) { fire(); return; }
    onAbort = fire;
    signal.addEventListener('abort', fire, { once: true });
  });
  // 正常读完的那条路上没人 race 到它 —— 不接住就是一次 unhandled rejection。
  hitDeadline.catch(() => {});

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), hitDeadline]);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_IDP_LIST_BYTES) throw tooLarge(total);
      chunks.push(value);
    }
  } catch (err) {
    // 上限与 deadline 都是我们自己的判决，原样往上抛；其余（连接被掐）算「没抓到」。
    if (err instanceof KydogError) throw err;
    throw new KydogError('institution.idp_list_unavailable', `机构清单没读完：${errText(err)}`, err);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/**
 * 抓一次清单。抛两种码，且**两种必须分开**：
 * - `institution.idp_list_unavailable`：压根没拿到字节（网络错、撞 deadline、非 2xx）。处置是重试。
 * - `institution.idp_list_invalid`：拿到了但读不成清单。处置不是重试。
 */
async function fetchIdpList(doFetch: typeof fetch, timeoutMs: number): Promise<IdpEntry[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await doFetch(IDP_LIST_URL, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    } catch (err) {
      throw new KydogError('institution.idp_list_unavailable', `机构清单没抓到：${errText(err)}`, err);
    }
    if (!res.ok) {
      throw new KydogError('institution.idp_list_unavailable', `机构清单没抓到：HTTP ${res.status}`);
    }
    const bytes = await readCapped(res, ctrl.signal, timeoutMs);
    const parsed = parseIdpList(decodeByCharset(bytes, res.headers.get('content-type')));
    // `dropped` 大于 0 时 entries 是不完整的，`parseIdpList` 的契约要求调用方说出口。
    // 现在只说到日志里：`IdpListPublic` 没有截断字段，而实测量级（1064 条）离
    // MAX_IDP_ENTRIES(5000) 还有 4.7 倍，这条路今天到不了。设置页要显示它的时候再加字段，
    // 别现在凭空造一个没人读的键。
    if (parsed.dropped.entries > 0 || parsed.dropped.skipped > 0 || parsed.skipped.length > 0) {
      logger.warn('institution.idpList', '机构清单有条目没能用上', {
        kept: parsed.entries.length,
        skipped: parsed.skipped.length,
        dropped: parsed.dropped,
        ambiguousNames: parsed.ambiguousNames.length,
      });
    }
    return parsed.entries;
  } finally {
    // 清在最外层：清早了 deadline 就只罩得住响应头，罩不住正文那一段读取。
    clearTimeout(timer);
  }
}

export class InstitutionService {
  private readonly safe: SafeStoragePort;
  private readonly settings: SettingsService;
  private readonly injectedFetch?: typeof fetch;
  private readonly injectedCacheFile?: string;
  /** 只为让「deadline 罩不罩得住正文那一段读取」这句话有用例守 —— 真机永远用默认值。 */
  private readonly timeoutMs: number;

  constructor(deps: {
    safeStorage: SafeStoragePort;
    settings: SettingsService;
    fetchFn?: typeof fetch;
    cacheFile?: string;
    timeoutMs?: number;
  }) {
    this.safe = deps.safeStorage;
    this.settings = deps.settings;
    this.injectedFetch = deps.fetchFn;
    this.injectedCacheFile = deps.cacheFile;
    this.timeoutMs = deps.timeoutMs ?? IDP_LIST_TIMEOUT_MS;
  }

  /** 每次取，不在构造时定死：用例是靠 spy `paths` 的 getter 改路径的。 */
  private get cacheFile(): string {
    return this.injectedCacheFile ?? paths.IDP_LIST_CACHE_FILE;
  }

  private get doFetch(): typeof fetch {
    return this.injectedFetch ?? fetch;
  }

  /** 渲染层看得到的那份。**密文与明文都不在里面**，只有 `hasPassword` 一个比特。 */
  async get(): Promise<InstitutionPublic> {
    return toInstitutionPublic((await this.settings.get()).institution);
  }

  /**
   * 保存机构账号。`password` 三档：省略 = 不动已存的、`null` 或 `''` = 清除、
   * 其余字符串 = 设为新值（当场加密）。
   *
   * 值一律不 trim：`sanitizeInstitution` 的承诺就是「只兜形状，不动值」，而密码的
   * 前后空格是有意义的字节。学号里粘进空格会在 IdP 那边直接登录失败 —— 那是一次
   * 响亮的失败，比我们悄悄改掉用户输入好。
   */
  async save(args: InstitutionSaveArgs): Promise<InstitutionPublic> {
    const record = await this.settings.updateInstitution((current) => ({
      name: args.name,
      entityID: args.entityID,
      username: args.username,
      passwordEnc: this.nextPasswordEnc(args.password, current),
      // 省略 = 保留（entityID 变了的话 checkInstitution 会当场把它归 null）；
      // null = 显式作废。**没有「设成某个值」这一档** —— 一次确认只能由 browser_login
      // 在真的问过用户之后经 settingsService.confirmLogin 写下。
      confirmedLogin: args.confirmedLogin === null ? null : (current?.confirmedLogin ?? null),
    }));
    return toInstitutionPublic(record);
  }

  /**
   * 算出这一次该落盘的 `passwordEnc`。**加密与「要不要加密」的判据在同一处**，
   * 免得判据在别处、加密在这里，两边漂开时变成「以为拒了、其实存了」。
   */
  private nextPasswordEnc(password: InstitutionSaveArgs['password'], current: InstitutionRecord | null): string {
    if (password === undefined) return current?.passwordEnc ?? '';
    // 空串与 null 同义：`passwordEnc: ''` 本来就表示「配了机构与账号，还没设密码」。
    // 把空串加密存进去会让 hasPassword 变成 true，而用户其实没有密码。
    if (password === null || password === '') return '';
    if (!this.safe.isEncryptionAvailable()) {
      // spec §4.6：**不许静默退回明文**。退回去的话，「我以为它加密了」与「它其实是明文」
      // 在界面上长得一模一样，而用户押的是校园统一身份认证的密码。
      throw new KydogError('settings.secure_storage_unavailable',
        '系统钥匙串当前不可用，密码没有保存 —— 不会退回明文存盘。请先让系统钥匙串可用，再设一次密码。');
    }
    // `isEncryptionAvailable()` 为 true 也不代表这一次加密就成得了：Electron 的
    // encryptString 自己会抛（那两步之间还隔着一次系统调用）。抛出来的原始错误里
    // **可能带上下文，而这一条上下文就在密码旁边** —— 所以只留 cause，不记日志、
    // 不把 message 拼进去。
    // 与「钥匙串不可用」同一个码：两者都是「钥匙串这一刻不行」，**修好之后重来有用**，
    // 而且都没有丢掉任何已经存下的密码。真正必须分开的是 reveal 那一侧的「密文解不开」。
    try {
      // `.toString('base64')` 不能省：encryptString 回的是 Buffer，直接往下塞会被
      // checkInstitution 判定整条不合格（从前是静默变成空串，界面显示「未设置密码」，
      // 见 settingsFile.ts 的 checkInstitution）。
      return Buffer.from(this.safe.encryptString(password)).toString('base64');
    } catch (err) {
      throw new KydogError('settings.secure_storage_unavailable',
        '系统钥匙串没能加密这个密码，没有保存 —— 不会退回明文存盘。'
        + '请先让系统钥匙串恢复可用，再设一次密码；已经存下的密码没有受影响。', err);
    }
  }

  async clear(): Promise<void> {
    await this.settings.clearInstitution();
  }

  /**
   * 「显示密码」。**明文唯一的出口**，而且只在渲染层显式问的那一刻走一次。
   *
   * 没配过机构 → `settings.invalid`（不是回空串：那会把「没配过」说成「没有密码」）。
   * 配了但没设密码 → 回空串，且根本不去解密。
   * 钥匙串这一刻不可用 → `settings.secure_storage_unavailable`：**密码还在**，
   * 修好钥匙串就照常取得出来。
   * 密文解不开 → `settings.stored_password_unreadable`：**密码永久失效**，修钥匙串
   * 没有用，只能重新填一次。
   *
   * 两者刻意**不共用一个码**：判据是「重试有没有用」，与本仓库对 `institution.idp_list_*`
   * 那一对用的是同一条规矩。合成一条的代价很具体 —— `hasPassword` 在两种情形下都还是
   * true，界面只能按码分支，于是「有一个密码、但它已经取不出来了」这个状态说不出来。
   */
  async reveal(): Promise<{ password: string }> {
    const inst = (await this.settings.get()).institution;
    if (inst === null) {
      throw new KydogError('settings.invalid', '还没有配置机构账号，没有密码可显示');
    }
    if (inst.passwordEnc === '') return { password: '' };
    if (!this.safe.isEncryptionAvailable()) {
      throw new KydogError('settings.secure_storage_unavailable',
        '系统钥匙串当前不可用，取不出已保存的密码 —— 密码还在，'
        + '让系统钥匙串恢复可用之后再试一次就行，不用重新填。');
    }
    try {
      return { password: this.safe.decryptString(Buffer.from(inst.passwordEnc, 'base64')) };
    } catch (err) {
      // 原始错误只进 cause（serializeError 只往渲染层送 code + message），不进日志 ——
      // 解密失败的异常里可能带上下文，而这一条上下文就在密码旁边。
      throw new KydogError('settings.stored_password_unreadable',
        '已保存的密码解不开了 —— 多半是换了机器，或者钥匙串里的条目被删了。'
        + '修钥匙串对这一份没有用，请到设置里重新填一次密码。', err);
    }
  }

  /**
   * 机构清单。`refresh` 不给且有缓存就直接用缓存，一次网络请求都不发。
   *
   * **抓不到时回落到落盘的旧清单，而不是回一份空清单** —— 空清单在设置页上等于
   * 「这个 SP 一个机构都没有」，与「我没抓到」长得一模一样。既抓不到又没有缓存时抛，
   * 让调用方看见真实原因（`unavailable` 该重试，`invalid` 重试也没用）。
   */
  async listIdps(args: { refresh?: boolean } = {}): Promise<IdpListPublic> {
    if (!args.refresh) {
      const cached = await this.readCache();
      if (cached) return { entries: cached.entries, fetchedAt: cached.fetchedAt, stale: true };
    }
    try {
      const entries = await fetchIdpList(this.doFetch, this.timeoutMs);
      const fetchedAt = new Date().toISOString();
      // 落盘失败**不许**把「刚抓到的这份」降级成「没抓到」：那会让磁盘满在界面上
      // 变成「网络不通」，而手里明明有一份新鲜的清单。
      await this.cacheIdps(entries, fetchedAt).catch((err: unknown) => {
        logger.warn('institution.idpList', '机构清单抓到了但没能落盘', { err: errText(err) });
      });
      return { entries, fetchedAt, stale: false };
    } catch (err) {
      const cached = await this.readCache();
      if (!cached) throw err;
      logger.warn('institution.idpList', '机构清单没抓到，回落到落盘的上一次', {
        fetchedAt: cached.fetchedAt, entries: cached.entries.length, err: errText(err),
      });
      return { entries: cached.entries, fetchedAt: cached.fetchedAt, stale: true };
    }
  }

  /**
   * 把一份清单连同「什么时候抓的」落盘。`listIdps` 抓到之后调它；也是用例喂缓存的入口。
   *
   * 不走 `atomicWriteWith0600Async`：里面全是公开的机构名与 entityID，没有任何用户数据。
   * （目录 `~/.kydog` 本来就是 0700。）
   */
  async cacheIdps(entries: IdpEntry[], fetchedAt: string): Promise<void> {
    await atomicWrite(this.cacheFile, JSON.stringify({ version: IDP_CACHE_VERSION, fetchedAt, entries }));
  }

  /**
   * 读落盘的清单。**读不懂就当没有**（回 null），一条都不留 —— 不是「悄悄丢掉坏的那几条」：
   * 半份缓存与完整缓存在调用方眼里长得一样，而缺的正好可能是用户那所学校。
   *
   * 这里的「当没有」不是静默降级：没有缓存时 `listIdps` 会去抓，抓不到就抛真实错误。
   */
  private async readCache(): Promise<IdpCache | null> {
    let raw: string;
    try {
      raw = await fsp.readFile(this.cacheFile, 'utf8');
    } catch {
      return null;   // 没有这个文件是常态（第一次打开设置页），不值得记一行日志
    }
    const bad = (why: string): null => {
      logger.warn('institution.idpList', '落盘的机构清单读不懂，当作没有', { why, file: this.cacheFile });
      return null;
    };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return bad('不是合法 JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bad('不是一个对象');
    const o = parsed as Record<string, unknown>;
    if (o.version !== IDP_CACHE_VERSION) return bad(`版本是 ${String(o.version)}，认识的是 ${IDP_CACHE_VERSION}`);
    if (typeof o.fetchedAt !== 'string' || o.fetchedAt === '') return bad('没有 fetchedAt');
    if (!Array.isArray(o.entries)) return bad('entries 不是数组');
    const entries: IdpEntry[] = [];
    for (const e of o.entries) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) return bad('有一条不是对象');
      const { name, entityID, flag } = e as Record<string, unknown>;
      if (typeof name !== 'string' || typeof entityID !== 'string') return bad('有一条缺 name 或 entityID');
      // flag 必填、可以是 null。写成可选的话，「源里没有前缀」与「缓存这一趟丢了它」
      // 在类型上长得一样 —— 那正是 IdpEntry.flag 定成必填要挡的事。
      if (flag !== null && typeof flag !== 'string') return bad('有一条的 flag 既不是字符串也不是 null');
      entries.push({ name, entityID, flag });
    }
    return { entries, fetchedAt: o.fetchedAt };
  }
}

/**
 * 主进程用的那一个。**真 `safeStorage` 只在这三行闭包里出现** —— 用例造自己的实例、
 * 注入假实现，于是「测试不许碰真钥匙串」是结构上做不到，而不是靠自觉。
 *
 * 三个方法**刻意各包一层闭包**，而不是 `safeStorage,` 一把交出去：那样 `safeStorage`
 * 这个绑定在**模块加载那一刻**就被读一次，于是任何 `import` 到这条链的用例都必须在
 * 自己的 `vi.mock('electron')` 里补一个 `safeStorage`，否则整个文件加载失败
 * （实测：把本服务接进 `handlers.ts` 之后，`handlers.test.ts` 当场以
 * 「No "safeStorage" export is defined on the "electron" mock」整份加载不了）。
 * 包一层之后，绑定只在真的调用时才读 —— 这在真机上也更对：`safeStorage` 本来就该在
 * app ready 之后才用。
 */
export const institutionService = new InstitutionService({
  safeStorage: {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plainText) => safeStorage.encryptString(plainText),
    decryptString: (encrypted) => safeStorage.decryptString(encrypted),
  },
  settings: settingsService,
});
