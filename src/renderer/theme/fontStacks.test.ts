import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// __dirname 是 src/renderer/theme/，向上三层是仓库根，node_modules 挂在那儿。
const THEME_DIR = __dirname;
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..');

const THEMES = ['porcelain', 'vellum', 'sepia', 'midnight', 'lilac'] as const;

const read = (p: string) => readFileSync(p, 'utf8');

/**
 * fonts.css 里 `@import "<裸包路径>"` 引进来的那几份 fontsource CSS。
 * 裸名按 Node 规则落到仓库根的 node_modules 下——与 Vite 解析这条 @import 时走的是同一条路。
 */
function importedFontCssPaths(): string[] {
  const css = read(path.join(THEME_DIR, 'fonts.css'));
  return [...css.matchAll(/@import\s+"([^"]+)"/g)]
    .map((m) => m[1])
    .map((spec) => path.join(ROOT_DIR, 'node_modules', spec));
}

/** 一份 CSS 里所有 @font-face 注册过的家族名（fontsource 一律用单引号）。 */
function registeredFamilies(css: string): Set<string> {
  return new Set([...css.matchAll(/font-family:\s*'([^']+)'/g)].map((m) => m[1]));
}

/** 一份主题 CSS 里所有 `--font-*` token 中带引号的家族名（不含 -apple-system / serif 这类关键字）。 */
function referencedFamilies(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(/^\s*--font-[\w-]*:\s*(.+);$/gm)) {
    for (const f of m[1].matchAll(/"([^"]+)"/g)) out.add(f[1]);
  }
  return out;
}

describe('字体栈与打包进来的字体', () => {
  /**
   * 守的是这样一类静默失效：族被打进了产物，但没有任何字体 token 写对它的**注册名**，于是那份
   * 字体一次都不会被用到，文字悄悄落到栈里的下一个族。
   *
   * 真实发生过：fontsource 的 variable 包把 @font-face 注册成「<家族> Variable」
   * （`'Source Serif 4 Variable'`），而五份主题的 --font-serif 首项写的是上游家族名
   * `"Source Serif 4"`——那个名字在任何机器上都匹配不到，全应用的拉丁衬线一直落到 Noto Serif
   * SC。它有拉丁字形所以看着「正常」，只是不是设计意图里那套字面，肉眼极难发现。
   *
   * 判据是「打进来的族必须至少被引用一次」，不是双向集合相等：栈里还有 Songti SC / Georgia /
   * -apple-system 这些**故意不打包**、靠系统提供的族，反方向断言会把它们全判成错。
   */
  it('每个打包进来的字体族，都至少被一个主题的字体 token 引用', () => {
    const referenced = new Set<string>();
    for (const t of THEMES) {
      for (const f of referencedFamilies(read(path.join(THEME_DIR, `${t}.css`)))) referenced.add(f);
    }

    const cssPaths = importedFontCssPaths();
    expect(cssPaths.length, 'fonts.css 里一条 @import 都没解析到').toBeGreaterThan(0);

    for (const p of cssPaths) {
      for (const family of registeredFamilies(read(p))) {
        expect(
          referenced,
          `${path.relative(ROOT_DIR, p)} 注册了 '${family}'，但没有任何主题的字体 token 写了这个名字`
            + `——这份字体打进了产物却永远不会被用到`,
        ).toContain(family);
      }
    }
  });

  /**
   * 族名改名时最容易漏掉某一份主题：漏掉的那份视觉上与其余四份不一致，而上一条断言只要求
   * 「至少被引用一次」，一份写对就绿。这里钉住五份主题的字体栈逐字相同。
   */
  it('五份主题的字体栈完全一致', () => {
    const stacks = THEMES.map((t) => {
      const css = read(path.join(THEME_DIR, `${t}.css`));
      return [...css.matchAll(/^\s*(--font-[\w-]*:\s*.+;)$/gm)].map((m) => m[1]).join('\n');
    });
    expect(stacks[0].length, '主题里没解析到任何 --font-* token').toBeGreaterThan(0);
    for (let i = 1; i < THEMES.length; i += 1) {
      expect(stacks[i], `${THEMES[i]}.css 的字体栈与 ${THEMES[0]}.css 不一致`).toBe(stacks[0]);
    }
  });
});
