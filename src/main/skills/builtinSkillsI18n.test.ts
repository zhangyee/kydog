import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { listBuiltinSkills, listSkillSourceFiles } from './builtinSkills';
import { projectSkillFiles, SKILL_LOCALES, DEFAULT_SKILL_LOCALE } from './localeProjection';

// __dirname 是 src/main/skills/，向上两层是 src/，内置 skill 源树挂在 src/skills 下。
// 这里不走 builtinSkillsRoot()：那个函数要问 electron 的 app.isPackaged，单测里没有。
const SRC_ROOT = path.resolve(__dirname, '..', '..', 'skills');

/**
 * 豁免名单——**显式白名单**，不做「看起来没文字就跳过」的自动判断。
 * 前缀匹配 `<skill 名>/<相对路径>`，所以既能豁免整个 skill（`fastpaper/`）也能豁免单个文件。
 */
const EXEMPT = [
  // 有期限的豁免：上游 fastpaper-cli 正在把 SKILL.md 改成中文、原英文挪成 SKILL.en.md。
  // 等 `npm run cli:update fastpaper@<双语 tag>` 落地后，它会自然通过下面的配对校验，
  // 届时**必须把这一行删掉** —— 设了就忘的例外正是这套校验最不该有的东西。
  'fastpaper/',
];

type Violation = { id: string; message: string };

/**
 * 双向配对检查，两个方向都由生产代码的 `projectSkillFiles` 直接推出来，
 * 不另写一份「怎么算变体」的解析 —— 那份副本一旦与 `splitLocale` 分叉，
 * 校验就会对着自己的规则打勾，而落盘走的是另一套。
 *
 * - 投影结果里 `源路径 === 投影后路径` ⟺ 这一格回落到了默认语言文件 → 缺该语言的变体。
 * - 某个 base 只在非默认语言的投影里出现 ⟺ 只有 `.en` 没有 base → 默认语言树里会少一个文件。
 */
function findViolations(): Violation[] {
  const out: Violation[] = [];
  for (const name of listBuiltinSkills(SRC_ROOT)) {
    const files = listSkillSourceFiles(SRC_ROOT, name);
    const defaults = projectSkillFiles(files, DEFAULT_SKILL_LOCALE);
    for (const locale of SKILL_LOCALES) {
      if (locale === DEFAULT_SKILL_LOCALE) continue;
      for (const [rel, src] of projectSkillFiles(files, locale)) {
        const dot = rel.lastIndexOf('.');
        const variant = dot === -1 ? `${rel}.${locale}` : `${rel.slice(0, dot)}.${locale}${rel.slice(dot)}`;
        if (!defaults.has(rel)) {
          out.push({
            id: `${name}/${src}`,
            message: `${name}/${src} 只有 ${locale} 变体，缺默认语言（${DEFAULT_SKILL_LOCALE}）的 ${name}/${rel}`,
          });
        } else if (src === rel) {
          out.push({
            id: `${name}/${rel}`,
            message: `${name}/${rel} 缺 ${locale} 变体：应有 ${name}/${variant}`,
          });
        }
      }
    }
  }
  return out;
}

const covered = (id: string): string | undefined => EXEMPT.find((prefix) => id.startsWith(prefix));

describe('内置 skill 的双语配对', () => {
  it('每个源文件都有全部语言变体，且每个变体都有默认语言的 base', () => {
    const offenders = findViolations().filter((v) => covered(v.id) === undefined);
    expect(offenders.map((v) => v.message)).toEqual([]);
  });

  it('豁免名单里每一条都仍然在挡着真实的缺口——挡不到东西就该删掉', () => {
    // 豁免是有期限的。上游补齐双语之后这条豁免不再有对应缺口，测试在这里变红，
    // 提醒把 EXEMPT 与 sync-skill-docs 的豁免清单一起删干净，而不是让它无声地留一辈子。
    const violations = findViolations();
    const dead = EXEMPT.filter((prefix) => !violations.some((v) => v.id.startsWith(prefix)));
    expect(dead).toEqual([]);
  });
});
