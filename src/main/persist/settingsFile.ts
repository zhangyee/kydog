// src/main/persist/settingsFile.ts
import { promises as fsp, statSync, chmodSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { atomicWriteWith0600Async } from './atomicWrite';
import * as paths from './paths';
import type { ConfirmedLogin, SettingsFile, TelemetryState } from '../../shared/types';
import { logger } from '../log';

/** 浏览器侧栏的默认宽度与下限。下限不是拍脑袋的：页面按固定 1280 逻辑视口渲染，
 *  320px 时 scale 已经是 0.25，再窄人眼读不了。 */
export const MIN_BROWSER_WIDTH = 320;
export const DEFAULT_BROWSER_WIDTH = 560;

/** 当前 schema 版本。判据、迁移与日志里的「支持范围」都从这里取，别再各写一个字面量 ——
 *  上一次 bump 时判据留在了 v8，v9 文件因此被判成「v1 或更旧」。 */
export const CURRENT_SCHEMA_VERSION = 9;

/** 写路径也要用它（settingsService.update），否则渲染层算错一次宽度就当场进 cache 与磁盘，
 *  而重启后这里又把它拉回默认 —— 现象是「重启就好了」，无法稳定复现。 */
export function sanitizeBrowserWidth(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= MIN_BROWSER_WIDTH
    ? Math.round(v) : DEFAULT_BROWSER_WIDTH;
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
      browserWidth: DEFAULT_BROWSER_WIDTH,
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
async function quarantineUnreadableSettings(raw: string, parsed: Extract<ParsedSettings, { kind: 'unreadable' }>): Promise<void> {
  // 文件名里不能有冒号：Windows 上建不出来。ISO8601 的 : 与 . 一并换成 -。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${paths.SETTINGS_FILE}.unreadable-${stamp}`;
  try {
    await atomicWriteWith0600Async(backup, raw);
  } catch (err) {
    logger.error('persist.settingsFile', 'settings unreadable, and backup failed; leaving the file alone', {
      reason: parsed.reason, rawVersion: parsed.rawVersion, backup, err: String(err),
    });
    return;
  }
  // 换掉原件，否则下一次启动会再判一次不可识别、再备份一份。
  try {
    await atomicWriteWith0600Async(paths.SETTINGS_FILE, JSON.stringify(defaultSettings(), null, 2));
  } catch (err) {
    logger.error('persist.settingsFile', 'settings unreadable; backed up but could not write defaults', {
      reason: parsed.reason, rawVersion: parsed.rawVersion, backup, err: String(err),
    });
    return;
  }
  logger.error('persist.settingsFile', 'settings unreadable; original backed up, starting from defaults', {
    reason: parsed.reason,
    // 原样，不转换：判断到底是版本号太新还是类型不对，靠的就是这个值本身
    rawVersion: parsed.rawVersion,
    rawVersionType: typeof parsed.rawVersion,
    supported: `1..${CURRENT_SCHEMA_VERSION}`,
    backup,
  });
}

/** 启动加载；不再需要 ENOENT fallback（init 已保证存在）。 */
export async function loadSettings(): Promise<SettingsFile> {
  let raw: string;
  try {
    raw = await fsp.readFile(paths.SETTINGS_FILE, 'utf8');
  } catch (err) {
    logger.warn('persist.settingsFile', 'load failed; returning defaults', { err: String(err) });
    return defaultSettings();
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
  if (parsed.kind === 'ok') return parsed.settings;
  await quarantineUnreadableSettings(raw, parsed);
  return defaultSettings();
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
/**
 * 已确认的登录页只在**同一个 entityID 下**有效。
 *
 * 不绑定的话：用户先配北大（确认过 iaaa.pku.edu.cn），后来改选清华并换成清华的学号密码 →
 * 判据里 confirmedLogin 那一支直接 return、entityID 根本不参与 → 主进程把清华账号密码
 * 填进北大的统一身份认证页。所以这里按记录自己的 entityID 复核一次：不符即作废。
 *
 * 只认 `{ entityID, origin }` 这一种形状。旧的 `confirmedLoginHost`（只有 host、没有
 * scheme）**不做转换** —— 补一个 https:// 是我们编的，不是用户确认过的那个 origin，
 * 而 urlGuard 放行 http，编错了就等于把同一个 Wi-Fi 上的应答也认下来。代价只是
 * 多问用户一次。
 */
function sanitizeConfirmedLogin(v: unknown, entityID: string): ConfirmedLogin | null {
  if (!isPlainObject(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.entityID !== 'string' || typeof o.origin !== 'string') return null;
  if (!o.entityID || !o.origin) return null;
  if (o.entityID !== entityID) return null;
  return { entityID: o.entityID, origin: o.origin };
}

/**
 * 机构账号只兜形状，不动值。三个标识字段缺一不可 —— 缺了就整条丢回 null，
 * 而不是补一个空串：一条 name/entityID 为空的记录在设置页上看起来像「配过了」，
 * 但 browser_login 的域判据会在运行时才失败，那时用户已经不记得自己填过什么。
 *
 * **写路径共用这一个函数**（settingsService.setInstitution）：读路径会丢掉的记录，
 * 写的时候就该被拒，不然就是「保存成功、重启后消失」。
 */
export function sanitizeInstitution(v: unknown): SettingsFile['institution'] {
  if (!isPlainObject(v)) return null;
  const o = v as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null);
  const name = str('name'), entityID = str('entityID'), username = str('username');
  if (!name || !entityID || !username) return null;
  return {
    name, entityID, username,
    passwordEnc: typeof o.passwordEnc === 'string' ? o.passwordEnc : '',
    confirmedLogin: sanitizeConfirmedLogin(o.confirmedLogin, entityID),
  };
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
 *    界面不该自己多出一栏；宽度取默认值，且低于 MIN_BROWSER_WIDTH 的手改值会被拉回默认。
 *    同时新增 institution；旧的 confirmedLoginHost 不做转换，见 sanitizeInstitution。
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
