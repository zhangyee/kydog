import { assertSafeRel } from './safeRel';

export type SkillLocale = 'zh' | 'en';

/** 白名单是显式常量，不做「看起来像语言码」的猜测：
 *  `vendor.min.js` 的 `min` 与 `report.en.html` 的 `en` 在形态上无法区分，
 *  靠启发式区分就会静默吃掉文件。加语言时只改这里。 */
export const SKILL_LOCALES = ['zh', 'en'] as const;
/** 「默认语言就是无后缀那份源文件」这条约定的名字。**生产代码不引用它**：投影永远拿显式
 *  传进来的 locale，不做兜底。它服务 `builtinSkillsI18n.test.ts` 的配对校验 ——
 *  那道校验要判「哪一份该是无后缀的」，把这个常量写成字面量 'zh' 反而是把约定散开。
 *  故意保留，不是漏删。 */
export const DEFAULT_SKILL_LOCALE: SkillLocale = 'zh';

const LOCALE_SET: ReadonlySet<string> = new Set(SKILL_LOCALES);

/** `references/writing.en.md` → { base: 'references/writing.md', locale: 'en' }
 *  `vendor.min.js`           → { base: 'vendor.min.js',          locale: null } */
function splitLocale(rel: string): { base: string; locale: SkillLocale | null } {
  const slash = rel.lastIndexOf('/');
  const dir = slash === -1 ? '' : rel.slice(0, slash + 1);
  const name = slash === -1 ? rel : rel.slice(slash + 1);
  const parts = name.split('.');
  // 需要 base.locale.ext 三段；`Makefile.en` 只有两段，不算变体
  if (parts.length < 3) return { base: rel, locale: null };
  const candidate = parts[parts.length - 2];
  if (!LOCALE_SET.has(candidate)) return { base: rel, locale: null };
  parts.splice(parts.length - 2, 1);
  return { base: dir + parts.join('.'), locale: candidate as SkillLocale };
}

/**
 * 源侧相对路径列表 + locale → Map<投影后路径, 源路径>。
 *
 * 规则：同一 base 下，命中当前 locale 的变体优先，否则回落到无后缀的默认文件。
 * 变体文件本身永不作为 key 出现 —— `SKILL.en.md` 不落盘。
 * 两种情况会让一个 base 从结果里消失：只有别的语言的变体、或只有 `.en` 而 locale 是 zh。
 * 这里不报错，由源侧的配对校验（Task 11）在 gate 命令里挡住。
 */
export function projectSkillFiles(srcRels: string[], locale: SkillLocale): Map<string, string> {
  const slots = new Map<string, { def?: string; variant?: string }>();
  for (const rel of srcRels) {
    assertSafeRel(rel, 'projection source');
    const { base, locale: l } = splitLocale(rel);
    assertSafeRel(base, 'projection target');
    const slot = slots.get(base) ?? {};
    if (l === null) slot.def = rel;
    else if (l === locale) slot.variant = rel;
    slots.set(base, slot);
  }
  const out = new Map<string, string>();
  for (const [base, slot] of slots) {
    const src = slot.variant ?? slot.def;
    if (src !== undefined) out.set(base, src);
  }
  return out;
}
