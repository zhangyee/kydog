// src/main/persist/settingsFile.ts
import { promises as fsp, statSync, chmodSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { atomicWriteWith0600Async } from './atomicWrite';
import * as paths from './paths';
import type { ConfirmedLogin, SettingsFile, TelemetryState } from '../../shared/types';
import { MIN_BROWSER_WIDTH } from '../../shared/types';
import { DEFAULT_MD_EXPORT, sanitizeMdExport } from '../../shared/mdExport';
import { logger } from '../log';

/** 浏览器侧栏的默认宽度与下限。**真源在 `shared/types.ts`** —— 渲染层拖拽时也要用
 *  同一个下限当场钳一次，而它 import 不了本模块（这里有 node:fs 与 electron 的路径）。
 *  这里原样转出去，让既有调用方与用例不必改 import。 */
export { MIN_BROWSER_WIDTH, DEFAULT_BROWSER_WIDTH } from '../../shared/types';

/** 当前 schema 版本。判据、迁移与日志里的「支持范围」都从这里取，别再各写一个字面量 ——
 *  上一次 bump 时判据留在了 v8，v9 文件因此被判成「v1 或更旧」。 */
export const CURRENT_SCHEMA_VERSION = 9;

/**
 * 写路径也要用它（settingsService.update），否则渲染层算错一次宽度就当场进 cache 与磁盘。
 *
 * `null` = **用户从没拖过**，由渲染层按当前窗口算 4:6（`rightPane.ts` 的 `browserWidthFor`）。
 *
 * **不需要升 schemaVersion**：旧文件里是数字，读出来照旧；新文件写 null，被旧版本读到时
 * 它那份 sanitize 回 `DEFAULT_BROWSER_WIDTH`，降级安全。
 *
 * 坏值回 `null` 而不是回一个默认宽度：编一个宽度出来就等于替用户做了个他没做过的决定，
 * 而 `null` 的意思恰好就是「他没做过决定」。
 */
export function sanitizeBrowserWidth(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= MIN_BROWSER_WIDTH ? Math.round(v) : null;
}

export function defaultSettings(): SettingsFile {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ui: {
      theme: 'vellum',
      locale: 'zh',
      workspaceCollapsed: false,
      inspectorCollapsed: false,
      readingFontSize: 'medium',
      collapsedProjects: [],
      browserOpen: false,
      // null = 从没设定过，见 sanitizeBrowserWidth 的注释。DEFAULT_BROWSER_WIDTH
      // 这个常量本身留着，供渲染层与用例里「一个合法宽度长什么样」的兜底用。
      browserWidth: null,
      mdExport: { ...DEFAULT_MD_EXPORT },
    },
    llm: {
      auth: {},
      providers: {},
      customProviders: [],
      defaultProvider: null,
      defaultModel: null,
    },
    skills: { disabledBuiltins: [] },
    tools: { externalBins: [] },
    research: { presets: {}, custom: [] },
    institution: null,
    updates: { autoCheck: true, dismissedCandidateId: null },
    telemetry: { state: 'undecided', decidedAt: null },
    onboarding: { completedAt: null },
  };
}

const POSIX = process.platform !== 'win32';

/** main 启动时调一次。确保 ~/.kydog/ 目录与 kydog.json 都存在且 0600。 */
export function ensureSettingsFile(): void {
  mkdirSync(paths.ROOT, { recursive: true, mode: POSIX ? 0o700 : undefined });
  if (POSIX) {
    try { chmodSync(paths.ROOT, 0o700); } catch { /* 忽略 */ }
  }
  if (!existsSync(paths.SETTINGS_FILE)) {
    const data = JSON.stringify(defaultSettings(), null, 2);
    writeFileSync(paths.SETTINGS_FILE, data, POSIX ? { encoding: 'utf8', mode: 0o600 } : 'utf8');
  }
}

/**
 * 认不出来的 settings 文件：**先把原件原样留档，再起一份全新的默认设置**。
 *
 * 不是「就地重置」。装了带更新 schema 的版本再回退时，磁盘上那份文件里有 API key、
 * 机构账号、research presets、onboarding 标记 —— 重置就是把它们静默删掉，而 onboarding
 * 一写盘就固化。这个项目发版史上已经有两桩需要回退的事故，不是假想路径。
 *
 * 顺序是「先备份、后覆盖」，备份失败就**不覆盖**：留着一份读不懂的文件，也好过既读不懂
 * 又没了。两次写都走 atomicWriteWith0600Async —— 备份里同样有明文密钥，权限不能松。
 *
 * **已知限制：备份是「按 utf8 读进来再写出去」，不是 rename，所以不是逐字节复制。**
 * 原文里若有非法 UTF-8 序列（`reason: 'not-json'` 最可能的成因就是被外部工具写坏），
 * 那些字节在 `loadSettings` 的 readFile 那一步就已经变成 U+FFFD，用户没法再从备份里
 * 逐字节捞回 `sk-…`。这是选用 atomicWrite 而非 fs.rename 的代价，不是疏漏：rename 会
 * 把原路径整个搬走，而这条路径的前提是「原件在备份成功之前必须原地不动」。
 */
/**
 * 返回值说的是**磁盘上那份还要不要保**：
 *  · `backedUp: true` —— 原文已经留档，盘上那份可以覆盖了。
 *  · `backedUp: false` —— **备份没成，原件还在原地**。这时候写默认值就是把那份
 *    「我们刚决定舍不得覆盖」的文件毁掉 —— 调用方必须按 `unreadable` 处置。
 */
async function quarantineUnreadableSettings(raw: string, parsed: Extract<ParsedSettings, { kind: 'unreadable' }>): Promise<{ backedUp: true; backup: string } | { backedUp: false }> {
  // 文件名里不能有冒号：Windows 上建不出来。ISO8601 的 : 与 . 一并换成 -。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${paths.SETTINGS_FILE}.unreadable-${stamp}`;
  try {
    await atomicWriteWith0600Async(backup, raw);
  } catch (err) {
    logger.error('persist.settingsFile', 'settings unreadable, and backup failed; leaving the file alone', {
      reason: parsed.reason, rawVersion: parsed.rawVersion, backup, err: String(err),
    });
    return { backedUp: false };
  }
  // 换掉原件，否则下一次启动会再判一次不可识别、再备份一份。
  try {
    await atomicWriteWith0600Async(paths.SETTINGS_FILE, JSON.stringify(defaultSettings(), null, 2));
  } catch (err) {
    logger.error('persist.settingsFile', 'settings unreadable; backed up but could not write defaults', {
      reason: parsed.reason, rawVersion: parsed.rawVersion, backup, err: String(err),
    });
    // 备份**成了**，只是没把原件换掉 —— 留档已经在，盘上那份可以覆盖。
    return { backedUp: true, backup };
  }
  logger.error('persist.settingsFile', 'settings unreadable; original backed up, starting from defaults', {
    reason: parsed.reason,
    // 原样，不转换：判断到底是版本号太新还是类型不对，靠的就是这个值本身
    rawVersion: parsed.rawVersion,
    rawVersionType: typeof parsed.rawVersion,
    supported: `1..${CURRENT_SCHEMA_VERSION}`,
    backup,
  });
  return { backedUp: true, backup };
}

/**
 * 一次读盘的**结果本身**，不只是那份设置。
 *
 * 分这四档是因为「拿到的是默认设置」有两种完全相反的成因，而**写路径必须分得开**：
 *  · `absent` / `ok` / `quarantined` —— 磁盘上没有需要保住的东西了（文件真的不在、
 *    读成功、或原件已经改名留档），此时按默认设置往下写是对的。
 *  · `unreadable` —— **原件还在，只是这一次没读出来**（EACCES、EBUSY、EIO、EMFILE…）。
 *    此时写盘就是拿默认值把一份好文件盖掉。里面有机构密码密文与 LLM API key，
 *    而这条路**既没有备份也没有提示** —— 用户只会发现凭据不见了。
 *
 * 从前只有 `loadSettings()`，两种成因都回默认设置，`withLock` 分不出来照写不误。
 * 这不是假想路径：`withLock` 每次写盘前都会 `loadSettings()` 一次（那正是它存在的
 * 理由——拿锁内最新的磁盘状态），所以一次瞬时读失败 + 任何一次设置改动 = 覆盖。
 */
export type SettingsRead =
  | { kind: 'ok'; settings: SettingsFile }
  /** 文件真的不在（ENOENT）。`ensureSettingsFile` 之后仍然 ENOENT 只可能是外部删了它。 */
  | { kind: 'absent'; settings: SettingsFile }
  /** 认不出来：原件**已经改名留档**（`backup` 是留档的文件名），磁盘上那份可以覆盖了。 */
  | { kind: 'quarantined'; settings: SettingsFile; backup: string }
  /** 读不出来：**原件还在原地**。`why` 是 errno（`EACCES` 这类），不带路径也不带内容。 */
  | { kind: 'unreadable'; settings: SettingsFile; why: string };

/**
 * 读盘并给出判据。**要写盘的调用方必须走这个，不能走 `loadSettings()`** ——
 * 后者把四档压成一份设置，`unreadable` 与 `absent` 从返回值上看长得一模一样。
 */
export async function readSettings(): Promise<SettingsRead> {
  let raw: string;
  try {
    raw = await fsp.readFile(paths.SETTINGS_FILE, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      logger.warn('persist.settingsFile', 'settings file absent; starting from defaults', {});
      return { kind: 'absent', settings: defaultSettings() };
    }
    // **只把 errno 带出去**：`String(err)` 里有文件路径，而这个 why 要经 app.bootstrap
    // 过河进渲染层。errno 足够说清「是权限还是占用」，路径对用户没有新信息。
    logger.error('persist.settingsFile', 'settings unreadable; refusing to overwrite it', {
      code: code ?? '(no errno)', err: String(err),
    });
    return { kind: 'unreadable', settings: defaultSettings(), why: code ?? 'unknown' };
  }
  if (POSIX) {
    try {
      const mode = statSync(paths.SETTINGS_FILE).mode & 0o777;
      if (mode & 0o077) {
        logger.warn('persist.settingsFile', 'file mode loosened; resetting to 0600', { mode: mode.toString(8) });
        await fsp.chmod(paths.SETTINGS_FILE, 0o600);
      }
    } catch { /* 忽略 */ }
  }
  const parsed = parseAndMigrateSettings(raw);
  if (parsed.kind === 'ok') return { kind: 'ok', settings: parsed.settings };
  const q = await quarantineUnreadableSettings(raw, parsed);
  // **备份没成 = 原件还在原地**，此时和「读不出来」是同一件事：不许写。
  // 少了这一支的话，「舍不得覆盖」那道护栏挡住的文件会被下一次 withLock 写掉。
  if (!q.backedUp) return { kind: 'unreadable', settings: defaultSettings(), why: 'backup-failed' };
  return { kind: 'quarantined', settings: defaultSettings(), backup: q.backup };
}

/**
 * 只要那份设置的读路径。**写盘之前不要用它** —— 见 `readSettings` 那段：
 * 它把「原件还在、只是没读出来」压成了和「文件真的不在」一样的返回值。
 */
export async function loadSettings(): Promise<SettingsFile> {
  return (await readSettings()).settings;
}

/**
 * **这里刻意没有一个「写整份 settings」的导出口。**
 *
 * 从前有一个 `saveSettings(value)`：零调用方，而且是一条**绕过 `withLock` 与
 * `sanitizeInstitution`** 的写口。本分支把 `sanitizeInstitution` 立成了机构密码落盘
 * 前的唯一净化点（`passwordEnc` 就是从这里过的），它正好绕过去 —— 谁顺手用它写一次，
 * 净化与文件锁两样一起丢，而且不报错。落盘一律走
 * `settingsService.update()`（内部 `withLock` + sanitize）。
 */

function sanitizeLocale(v: unknown): 'zh' | 'en' { return v === 'en' ? 'en' : 'zh'; }

/** ui 其余字段是标量、坏值最多显示得怪；这条是数组，坏值会让渲染层 `new Set(...)`
 *  直接抛。所以只有它单独兜形状：非数组回空，非字符串元素丢掉。 */
function sanitizeCollapsedProjects(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** 数组也是 object，单靠 typeof 分不出来 —— research 的两个容器都要排除数组。 */
function isPlainObject(v: unknown): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** updates 逐字段兜形状 —— 某个字段类型不对就只把该字段回默认，不牵连另一个。 */
/** 一条记录的形状与归属校验。形状不对或 entityID 不符就回 null。 */
function oneConfirmedLogin(v: unknown, entityID: string): ConfirmedLogin | null {
  if (!isPlainObject(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.entityID !== 'string' || typeof o.origin !== 'string') return null;
  if (!o.entityID || !o.origin) return null;
  if (o.entityID !== entityID) return null;
  return { entityID: o.entityID, origin: o.origin };
}

/**
 * 已确认的登录页只在**同一个 entityID 下**有效，而且**可以有多条**。
 *
 * 不绑定 entityID 的话：用户先配北大（确认过 iaaa.pku.edu.cn），后来改选清华并换成
 * 清华的学号密码 → 判据里那一支直接放行、entityID 根本不参与 → 主进程把清华账号密码
 * 填进北大的统一身份认证页。所以这里按记录自己的 entityID 复核一次：不符即剔除。
 *
 * **旧的单条 `confirmedLogin`（对象或 null）要迁移过来**，形状逐字相同、转换无损；
 * 丢弃会让每个已配置机构的用户平白多确认一次。**但新键一旦存在就以它为准，
 * 哪怕它是脏数据也不回落到旧键** —— 回落会让一条被判定为无效的新记录被一条旧记录
 * 悄悄顶替，而两者可能指向不同的 origin。
 *
 * 更早的 `confirmedLoginHost`（只有 host、没有 scheme）**仍然一概不认**：
 * 补一个 https:// 是我们编的，不是用户确认过的那个 origin，而 urlGuard 放行 http，
 * 编错了就等于把同一个 Wi-Fi 上的应答也认下来。代价只是多问用户一次。
 *
 * **不设上限**，理由见 `InstitutionRecord.confirmedLogins` 的注释。
 */
function sanitizeConfirmedLogins(o: Record<string, unknown>, entityID: string): ConfirmedLogin[] {
  const raw = 'confirmedLogins' in o ? o.confirmedLogins : o.confirmedLogin;
  const list = Array.isArray(raw) ? raw : [raw];
  const out: ConfirmedLogin[] = [];
  for (const item of list) {
    const one = oneConfirmedLogin(item, entityID);
    if (one === null) continue;
    if (out.some((x) => x.origin === one.origin)) continue;
    out.push(one);
  }
  return out;
}

/**
 * `checkInstitution` 的结果。**「为什么不行」必须能带出来**：读路径只需要「行不行」
 * （不行就整条丢），写路径要把原因原样说给用户 —— 从前写路径无论什么原因都只会说
 * 「缺少机构名 / entityID / 用户名」，而 passwordEnc 那一档的真实原因完全不是这个。
 *
 * 判据只有这一个函数（`sanitizeInstitution` 是它的薄包装），所以「读路径会丢的记录、
 * 写路径就该拒」这条不变式不可能漂：两边问的是同一个人。
 */
export type InstitutionCheck =
  | { ok: true; record: NonNullable<SettingsFile['institution']> }
  | { ok: false; why: string };

/**
 * 机构账号只兜形状，不动值。三个标识字段缺一不可 —— 缺了就整条丢回 null，
 * 而不是补一个空串：一条 name/entityID 为空的记录在设置页上看起来像「配过了」，
 * 但 browser_login 的域判据会在运行时才失败，那时用户已经不记得自己填过什么。
 *
 * **写路径共用这一个函数**（settingsService.updateInstitution / .confirmLogin）：
 * 读路径会丢掉的记录，写的时候就该被拒，不然就是「保存成功、重启后消失」。
 *
 * **passwordEnc 分三档，中间那档以前不存在：**
 * - 没有这个键 → `''`。「配了机构与账号，但还没设密码」是一个合法状态。
 * - 有这个键但不是字符串 → **整条不合格**。以前这一档被静默改写成 `''`，代价很具体：
 *   `safeStorage.encryptString` 回的是 **Buffer**，实现者忘了 `.toString('base64')`
 *   直接往下塞 → `typeof === 'string'` 为 false → 落盘 `passwordEnc: ''` →
 *   界面显示「未设置密码」，**全程没有任何错误**。三个标识字段缺失会抛，唯独密码这一档
 *   静默降级，两条路对不齐；现在对齐了。
 * - 是字符串（含 `''`）→ 原样收下。这里不校验它是不是合法 base64：那要解密才知道，
 *   而解密只在 institutionService.reveal 那一刻发生，解不开时它抛
 *   `settings.secure_storage_unavailable`。在这里假装校验过反而是编一个事实。
 */
export function checkInstitution(v: unknown): InstitutionCheck {
  if (!isPlainObject(v)) return { ok: false, why: '不是一个对象' };
  const o = v as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);
  const name = str('name'), entityID = str('entityID'), username = str('username');
  if (!name || !entityID || !username) return { ok: false, why: '缺少机构名 / entityID / 用户名' };
  if ('passwordEnc' in o && typeof o.passwordEnc !== 'string') {
    return {
      ok: false,
      why: `passwordEnc 不是字符串（收到 ${o.passwordEnc === null ? 'null' : typeof o.passwordEnc}）`
        + ` —— safeStorage.encryptString 回的是 Buffer，落盘前必须 .toString('base64')`,
    };
  }
  return {
    ok: true,
    record: {
      name, entityID, username,
      passwordEnc: typeof o.passwordEnc === 'string' ? o.passwordEnc : '',
      confirmedLogins: sanitizeConfirmedLogins(o, entityID),
    },
  };
}

/** 读路径用的薄包装：不合格就整条 null。要知道**为什么**不合格就用 checkInstitution。 */
export function sanitizeInstitution(v: unknown): SettingsFile['institution'] {
  const r = checkInstitution(v);
  return r.ok ? r.record : null;
}

function sanitizeUpdates(v: unknown): SettingsFile['updates'] {
  const d = { autoCheck: true, dismissedCandidateId: null as string | null };
  if (!isPlainObject(v)) return d;
  const o = v as Record<string, unknown>;
  return {
    autoCheck: typeof o.autoCheck === 'boolean' ? o.autoCheck : d.autoCheck,
    dismissedCandidateId: typeof o.dismissedCandidateId === 'string' ? o.dismissedCandidateId : null,
  };
}

const TELEMETRY_STATES: readonly TelemetryState[] = ['undecided', 'enabled', 'deleting', 'disabled'];

function sanitizeTelemetry(v: unknown): SettingsFile['telemetry'] {
  const d = { state: 'undecided' as TelemetryState, decidedAt: null as string | null };
  if (!isPlainObject(v)) return d;
  const o = v as Record<string, unknown>;
  // state 非法说明整份记录不可信，decidedAt 一并回落
  if (!TELEMETRY_STATES.includes(o.state as TelemetryState)) return d;
  return {
    state: o.state as TelemetryState,
    decidedAt: typeof o.decidedAt === 'string' ? o.decidedAt : null,
  };
}

/**
 * 解析结果。**「认不出来」必须是一个可判别的分支，不能用「一份默认设置」表示** ——
 * 那两件事在调用方眼里长得一模一样，而处置完全相反：一个该迁移，一个该留档。
 */
export type ParsedSettings =
  | { kind: 'ok'; settings: SettingsFile }
  | {
      kind: 'unreadable';
      reason: 'not-json' | 'not-an-object' | 'unknown-version';
      /** 原样带出来，不转换。到底是「版本号比自己新」还是「类型不对」，靠的就是这个值本身。 */
      rawVersion: unknown;
    };

/**
 * 三档，缺一不可：
 * - `known`（2..CURRENT）：正常迁移/回读。
 * - `legacy`（整数 ≤ 1）：v1 或更旧，走那条有意的升级路径。
 * - `unknown`：**比自己新的版本**，以及**类型不符**（字符串 "9"、null、非整数、缺字段）。
 *
 * 第三档以前不存在，全都落进 legacy 那条重置分支。用户装了带 v10 的版本再回退，
 * 磁盘上的 v10 就被判成「v1 或更旧」，API key / research presets / 机构账号 / onboarding
 * 全部重置，且 onboarding 一写盘就固化。
 */
function classifyVersion(v: unknown): 'known' | 'legacy' | 'unknown' {
  if (typeof v !== 'number' || !Number.isInteger(v)) return 'unknown';
  if (v >= 2 && v <= CURRENT_SCHEMA_VERSION) return 'known';
  if (v <= 1) return 'legacy';
  return 'unknown';   // 比自己新
}

/** v1..v8 → v9 迁移。
 *  - v1：保留 ui/skills/tools，重置 llm（与旧行为一致），补 readingFontSize / onboarding / research / updates 默认值。
 *  - v2..v8：保留所有字段，补缺失的 onboarding / research / updates 默认值。
 *  - v9：原样回写（completedAt 保留；locale 非法值归位 zh；updates 只兜形状）。
 *  - v6→v7：新增 telemetry，一律置 undecided（老用户从未被询问）。
 *  - v7→v8：新增 ui.collapsedProjects，一律置空（老用户的 project 全是展开的）。
 *  - v8→v9：新增 ui.browserOpen / ui.browserWidth。浏览器侧栏默认关闭 —— 老用户升级后
 *    界面不该自己多出一栏；宽度取 null（未设定，由渲染层现算 4:6），且低于
 *    MIN_BROWSER_WIDTH 或形状不对的手改值同样回 null，见 sanitizeBrowserWidth。
 *    同时新增 institution；旧的 confirmedLoginHost 不做转换，见 sanitizeInstitution。
 *  - ui.mdExport：不升版本，缺了补默认、坏值逐项回默认（sanitizeMdExport）。
 *  - 版本认不出来：返回 unreadable，**不重置**（调用方负责留档）。 */
export function parseAndMigrateSettings(raw: string): ParsedSettings {
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch { return { kind: 'unreadable', reason: 'not-json', rawVersion: undefined }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unreadable', reason: 'not-an-object', rawVersion: undefined };
  }
  const d = defaultSettings();
  const v = parsed.schemaVersion;
  const kind = classifyVersion(v);

  if (kind === 'unknown') return { kind: 'unreadable', reason: 'unknown-version', rawVersion: v };

  if (kind === 'known') {
    if (v !== CURRENT_SCHEMA_VERSION) logger.warn('persist.settingsFile', `migrating schema v${v} → v${CURRENT_SCHEMA_VERSION}`);
    return { kind: 'ok', settings: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      ui: {
        ...d.ui,
        ...(parsed.ui ?? {}),
        locale: sanitizeLocale(parsed.ui?.locale),
        collapsedProjects: sanitizeCollapsedProjects(parsed.ui?.collapsedProjects),
        browserOpen: parsed.ui?.browserOpen === true,
        browserWidth: sanitizeBrowserWidth(parsed.ui?.browserWidth),
        mdExport: sanitizeMdExport(parsed.ui?.mdExport),
      },
      llm: {
        auth: parsed.llm?.auth ?? {},
        providers: parsed.llm?.providers ?? {},
        customProviders: parsed.llm?.customProviders ?? [],
        defaultProvider: parsed.llm?.defaultProvider ?? null,
        defaultModel: parsed.llm?.defaultModel ?? null,
      },
      skills: { ...d.skills, ...(parsed.skills ?? {}) },
      tools: { ...d.tools, ...(parsed.tools ?? {}) },
      // 只兜形状不动值：get() 刻意返回落盘原值（让手改过 kydog.json 的用户
      // 能看见真实状态），所以这里不 trim、不校验内容，但必须保证容器与元素
      // 的形状与类型标注一致 —— 否则 research.get 会把 SettingsFile 上那句
      // Record<string,string> / ResearchCustomVar[] 的承诺撒谎给渲染层。
      research: {
        presets: isPlainObject(parsed.research?.presets) ? parsed.research.presets : {},
        custom: Array.isArray(parsed.research?.custom)
          ? parsed.research.custom.filter(isPlainObject)
          : [],
      },
      institution: sanitizeInstitution(parsed.institution),
      updates: sanitizeUpdates(parsed.updates),
      telemetry: sanitizeTelemetry(parsed.telemetry),
      onboarding: { completedAt: typeof parsed.onboarding?.completedAt === 'string' ? parsed.onboarding.completedAt : null },
    } };
  }

  // v1 或更旧：reset llm、补 ui 默认（包括 readingFontSize）。
  // 这是一条**有意的升级路径**，不是「兜底分支」—— 认不出来的版本在上面就已经返回
  // unreadable 了，绝不会落到这里被顺手重置。
  logger.warn('persist.settingsFile', `schema v${v} detected; resetting llm to v${CURRENT_SCHEMA_VERSION} default`);
  return { kind: 'ok', settings: {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    ui: {
      ...d.ui,
      ...(parsed.ui ?? {}),
      locale: sanitizeLocale(parsed.ui?.locale),
      collapsedProjects: sanitizeCollapsedProjects(parsed.ui?.collapsedProjects),
      browserOpen: parsed.ui?.browserOpen === true,
      browserWidth: sanitizeBrowserWidth(parsed.ui?.browserWidth),
      mdExport: sanitizeMdExport(parsed.ui?.mdExport),
    },
    llm: d.llm,
    skills: { ...d.skills, ...(parsed.skills ?? {}) },
    tools: { ...d.tools, ...(parsed.tools ?? {}) },
    research: d.research,
    institution: null,
    updates: d.updates,
    telemetry: sanitizeTelemetry(parsed.telemetry),
    onboarding: { completedAt: null },
  } };
}
