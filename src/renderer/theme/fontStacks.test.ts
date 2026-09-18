import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
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

/**
 * 字体只随产物走，不从任何字体 CDN 拉（原先由 e2e/58-font-stack 在运行期数请求守着）。
 *
 * 曾经 index.html 里有一个 Google Fonts 的 <link>：离线时观感与在线时不同、每次启动都向第三方
 * 发一次请求，而且远端那份恰好注册成与主题里同名的家族，把打包进来的那份静默顶掉（见上面
 * 「每个打包进来的字体族」那条的来由）。
 *
 * 这里改成静态扫：渲染层能把一个 URL 送进页面的源头只有这几处 —— 入口 index.html、渲染层
 * 源码（CSS 的 @import / url()，TS/TSX 里动态插 <link>、拼 CSS 串、new FontFace），以及
 * fonts.css 用 @import 引进来的那几份 fontsource CSS。测试文件不进产物，不扫。
 *
 * 守不住的：运行期从别处**拼**出来的 URL（域名被拆成几段字符串再拼起来）。那种写法本身就
 * 不该出现，这里不为它加判据。
 */
describe('渲染层不引用任何字体 CDN', () => {
  /** 常见的字体 CDN 域名。e2e/58 那张表（前四项）之外补了几个同类的，包括国内镜像。 */
  const FONT_CDN = /fonts\.googleapis\.(?:com|cn)|fonts\.gstatic\.(?:com|cn)|fonts\.bunny\.net|(?:use|p)\.typekit\.net|fast\.fonts\.net|fonts\.cdnfonts\.com|fonts\.loli\.net/g;

  const fontCdnHits = (text: string): string[] => [...text.matchAll(FONT_CDN)].map((m) => m[0]);

  /** 渲染层源码：src/renderer 下所有 .css / .html / .ts / .tsx，去掉测试文件。 */
  function rendererSources(dir: string): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...rendererSources(p));
      else if (/\.(css|html|tsx?)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  it('index.html、渲染层源码与 fonts.css 引进来的 fontsource CSS 里都没有字体 CDN 域名', () => {
    // 正向对照：扫描器本身认得出一条真的 CDN 引用（index.html 当年那一行的样子）。正则写坏了
    // （比如点号没转义错成别的、g 标志丢了让 matchAll 抛），下面那条「一个都没有」会假绿。
    expect(fontCdnHits(
      '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">'
      + '\n@font-face { src: url(https://fonts.gstatic.com/s/inter/v12/x.woff2); }',
    )).toEqual(['fonts.googleapis.com', 'fonts.gstatic.com']);

    const files = [
      path.join(ROOT_DIR, 'index.html'),
      ...rendererSources(path.join(ROOT_DIR, 'src', 'renderer')),
      ...importedFontCssPaths(),
    ];
    // 文件清单本身也要证明是对的：真扫到了入口、主题 CSS 和 node_modules 里的 fontsource，
    // 而不是一个空列表让下面那条断言无事可做。
    const rel = files.map((p) => path.relative(ROOT_DIR, p).split(path.sep).join('/'));
    expect(rel).toContain('index.html');
    expect(rel).toContain('src/renderer/theme/fonts.css');
    expect(rel).toContain('src/renderer/panels/main-pane/html/reportTheme.ts');
    expect(rel.some((p) => p.startsWith('node_modules/@fontsource'))).toBe(true);

    const hits = files.flatMap((p) => fontCdnHits(read(p)).map((h) => `${path.relative(ROOT_DIR, p)}: ${h}`));
    expect(hits, '渲染层引用了字体 CDN——字体要随产物打包（fonts.css 的 @import），不联网拉').toEqual([]);
  });
});

/**
 * OFL 1.1 要求署名。字体是随产物分发的，署名页因此是**法律义务**，不能靠改字体的人记得去改。
 *
 * 判据用包自己 metadata.json 里的 `family`（上游家族名，如 "Source Serif 4"），而不是 @font-face
 * 的注册名（"Source Serif 4 Variable"）——署名写的是前者，Variable 后缀是 fontsource 的打包约定，
 * 不是 Adobe 那套字体的名字。
 *
 * aboutDocs.test.ts 已经守住「列出的条目声明的 license 必须属实」，但它明说不管**漏列**。这条补的
 * 就是漏列：fonts.css 引了包，署名页却没提。
 */
describe('打包的字体必须在开源许可页里署名', () => {
  const licenses = read(path.resolve(ROOT_DIR, 'src', 'about', 'licenses.md'));

  it('每个被 @import 的字体包，上游家族名与包名都出现在 licenses.md 里', () => {
    const specs = [...read(path.join(THEME_DIR, 'fonts.css')).matchAll(/@import\s+"([^"]+)"/g)]
      .map((m) => m[1]);
    expect(specs.length, 'fonts.css 里一条 @import 都没解析到').toBeGreaterThan(0);

    // "@scope/name/400.css" → "@scope/name"；包名可能带 scope，所以取前两段
    const pkgs = new Set(specs.map((spec) => spec.split('/').slice(0, 2).join('/')));

    // 「字体」小节里逐行的 "<家族> © <权利人>" 才算署名。不能直接在全文里 includes(family)：
    // 下面成段的版权声明与 OFL 全文里也会出现家族名（"Copyright 2016 The Inter Project Authors"
    // 就含 "Inter"），那样删掉署名行测试照样绿——这条断言写过一版就是这么废的。
    const fontSection = licenses.slice(
      licenses.indexOf('## 字体'),
      licenses.indexOf('Licensed under the SIL Open Font License'),
    );
    const attributed = new Set(
      [...fontSection.matchAll(/^(.+?) © /gm)].map((m) => m[1].trim()),
    );

    for (const pkg of pkgs) {
      const meta = JSON.parse(
        read(path.join(ROOT_DIR, 'node_modules', pkg, 'metadata.json')),
      ) as { family?: string };
      expect(meta.family, `${pkg}/metadata.json 没有 family 字段`).toBeTruthy();
      expect(
        attributed,
        `licenses.md 的「字体」小节没有署名 '${meta.family as string}'（来自 ${pkg}）——OFL 要求署名。`
          + `已署名的是：${[...attributed].join('、')}`,
      ).toContain(meta.family as string);
      expect(
        licenses,
        `licenses.md 的「开源库」列表漏了 \`${pkg}\``,
      ).toContain(`\`${pkg}\``);
    }
  });
});
