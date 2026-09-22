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

export function languagesToLoad(doc: PmNode): LanguageDescription[] {
  const found = new Set<LanguageDescription>();
  for (const name of factsFromDoc(doc).codeLanguages) {
    if (isKnownLanguage(name)) found.add(languageMap[name.toLowerCase()]);
  }
  return [...found];
}

export type DocFacts = { codeLanguages: string[]; imageNodeSrcs: string[] };
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
  doc.descendants((node) => {
    if (node.type.name === 'code_block') codeLanguages.push(String(node.attrs.language ?? ''));
    if ((node.type.name === 'image-block' || node.type.name === 'image')
      && typeof node.attrs.src === 'string' && node.attrs.src !== '') imageNodeSrcs.push(node.attrs.src);
    return true;
  });
  return { codeLanguages, imageNodeSrcs };
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
  const expectTagged = f.codeLanguages.filter(isKnownLanguage).length;
  if (f.taggedCodeContents < expectTagged) return false;
  const expectLatex = f.codeLanguages.filter((l) => l.toLowerCase() === 'latex').length;
  if (f.latexPreviews < expectLatex) return false;
  // src 为空的图片节点不计：它永远不会有 img，计进去就只能等到超时（spec §3.4 第 5 条）
  if (f.imgs.length !== f.imageNodeSrcs.length) return false;
  return f.imgs.every((i) => i.complete);
}

/** PDF 里只留 http(s) 与 mailto 链接；其余去掉 href 只留文字（spec §2.5）。 */
export function isPrintableHref(href: string): boolean {
  return /^(https?:|mailto:)/i.test(href);
}
