import type { Node as PmNode } from '@milkdown/kit/prose/model';
import type { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';

/**
 * 导出 PDF 的打印页「排好了没有」的判据（spec 2026-09-22-md-export-pdf-design §3.4）。全是协议事实：
 * 数得出来的 DOM 与文档节点，没有「等几秒」。拆成纯函数，是因为页面本身只能靠 e2e 跑。
 */

/**
 * 与 @milkdown/components 的 LanguageLoader 同一规则：遍历 languages，把每个 alias（LanguageDescription.of
 * 已经把本名小写并进 alias 了）映射到它，后出现的覆盖先出现的。规则一旦不一致，「认得的语言都挂上了
 * data-language」这条就会对着一个 Crepe 根本不会加载的语言空等到 60 秒上限。
 */
const languageMap: Record<string, LanguageDescription> = {};
for (const lang of languages) for (const alias of lang.alias) languageMap[alias] = lang;

export function isKnownLanguage(name: string): boolean {
  return name !== '' && Object.prototype.hasOwnProperty.call(languageMap, name.toLowerCase());
}

/**
 * 判据 3（spec §3.4 第 3 条，Task 4 复审实测后改写）：认得的语言不一定要求带 data-language——
 * CodeMirror 只在加载出来的 `Language.name` 非空时才写这个属性（`@codemirror/language`
 * dist/index.js:662，`EditorView.contentAttributes.compute` 那段 `lang && lang.name ? {...} : {}`）。
 * `@codemirror/language-data` 里 Dockerfile / F# / OCaml / Pug / SML 五个加载后名字是空串——
 * 按「认得就要有属性」数，这几种语言的代码块会一直等到 60s 上限（Task 4 复审用真实 load() 实测）。
 * 还没 load() 完的语言故意当「要求」处理：宁可多等一轮 MutationObserver，也不要在名字还不知道
 * 时就提前放行；打印页在 waitUntil 之前已经把用到的语言全部 load() 过一轮，真到判据这一步时
 * 早就加载完毕，这个分支只在 isPrintReady 以外的场景（比如这里的单测）才会命中。
 */
export function expectsDataLanguage(name: string): boolean {
  if (!isKnownLanguage(name)) return false;
  const support = languageMap[name.toLowerCase()].support;
  return support === undefined || support.language.name !== '';
}

export function languagesToLoad(doc: PmNode): LanguageDescription[] {
  const found = new Set<LanguageDescription>();
  for (const name of factsFromDoc(doc).codeLanguages) {
    if (isKnownLanguage(name)) found.add(languageMap[name.toLowerCase()]);
  }
  return [...found];
}

export type DocFacts = { codeLanguages: string[]; imageNodeSrcs: string[]; nonEmptyLatexBlocks: number };
export type DomFacts = {
  placeholders: number;
  taggedCodeContents: number;
  latexPreviews: number;
  imgs: Array<{ src: string; complete: boolean }>;
};
export type PrintFacts = DocFacts & DomFacts;

/** 代码块（含公式块：Crepe 的公式块就是 language 为 LaTeX 的 code_block）与图片节点。 */
export function factsFromDoc(doc: PmNode): DocFacts {
  const codeLanguages: string[] = [];
  const imageNodeSrcs: string[] = [];
  let nonEmptyLatexBlocks = 0;
  doc.descendants((node) => {
    if (node.type.name === 'code_block') {
      const language = String(node.attrs.language ?? '');
      codeLanguages.push(language);
      // 判据 4（spec §3.4 第 4 条，Task 4 复审实测后改写）：Crepe 只在内容非空时渲染公式预览
      // （@milkdown/crepe src/feature/latex/index.ts:39，renderPreview 里
      // `language.toLowerCase() === 'latex' && content.length > 0` 才 renderLatex）——
      // 空公式块（`$$\n$$` 或空的 latex 语言代码块）没有 .preview，按「latex 语言就要有预览」
      // 数会一直等到超时。这里只数非空的，供 isPrintReady 的第 4 条判据用；
      // data-language 要不要挂（第 3 条判据）跟内容是否为空无关，仍然按 codeLanguages 全量数。
      if (language.toLowerCase() === 'latex' && node.textContent.length > 0) nonEmptyLatexBlocks += 1;
    }
    if ((node.type.name === 'image-block' || node.type.name === 'image')
      && typeof node.attrs.src === 'string' && node.attrs.src !== '') imageNodeSrcs.push(node.attrs.src);
    return true;
  });
  return { codeLanguages, imageNodeSrcs, nonEmptyLatexBlocks };
}

type QueryRoot = { querySelectorAll: (sel: string) => ArrayLike<unknown> };

/** 选择器以 Crepe 7.21.1 实际渲染的 DOM 为准（2026-09-22 探针实测）。 */
export function factsFromDom(root: QueryRoot): DomFacts {
  const all = <T>(sel: string) => Array.from(root.querySelectorAll(sel)) as T[];
  return {
    placeholders: all('.milkdown-code-block-placeholder').length,
    taggedCodeContents: all('.cm-content[data-language]').length,
    latexPreviews: all<{ childElementCount: number }>('.milkdown-code-block .preview-panel .preview')
      .filter((p) => p.childElementCount > 0).length,
    imgs: all<{ getAttribute: (n: string) => string | null; complete: boolean }>('img')
      .map((i) => ({ src: i.getAttribute('src') ?? '', complete: i.complete }))
      .filter((i) => i.src !== ''),
  };
}

export function isPrintReady(f: PrintFacts): boolean {
  if (f.placeholders !== 0) return false;
  // 第 3 条：只有 expectsDataLanguage 为 true 的（认得且加载出的名字非空，或还没加载完）才数进去
  const expectTagged = f.codeLanguages.filter(expectsDataLanguage).length;
  if (f.taggedCodeContents < expectTagged) return false;
  // 第 4 条：只有非空的 latex 块才要求 .preview（factsFromDoc 已经把空块排除在外）
  if (f.latexPreviews < f.nonEmptyLatexBlocks) return false;
  // src 为空的图片节点不计：它永远不会有 img，计进去就只能等到超时（spec §3.4 第 5 条）
  if (f.imgs.length !== f.imageNodeSrcs.length) return false;
  return f.imgs.every((i) => i.complete);
}

/** PDF 里只留 http(s) 与 mailto 链接；其余去掉 href 只留文字（spec §2.5）。 */
export function isPrintableHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}
