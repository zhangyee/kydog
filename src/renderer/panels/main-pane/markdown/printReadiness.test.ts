import { describe, it, expect } from 'vitest';
import { Schema } from '@milkdown/kit/prose/model';
import { languages } from '@codemirror/language-data';
import {
  isKnownLanguage, expectsDataLanguage, languagesToLoad, factsFromDoc, factsFromDom, isPrintReady, isPrintableHref,
  type PrintFacts,
} from './printReadiness';

// 只搭判据要读的那几种节点：名字与 Milkdown 实际用的一致（code_block / image / image-block）
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    code_block: { group: 'block', content: 'text*', attrs: { language: { default: '' } } },
    'image-block': { group: 'block', attrs: { src: { default: '' } } },
    image: { group: 'inline', inline: true, attrs: { src: { default: '' } } },
    text: { group: 'inline' },
  },
});
const code = (language: string) => schema.node('code_block', { language }, [schema.text('x')]);
// 空代码块：content 是 'text*'，零个 text 子节点也合法——用来搭「latex 内容为空」的夹具。
const codeEmpty = (language: string) => schema.node('code_block', { language }, []);
const doc = schema.node('doc', null, [
  // js / javascript 是同一个 LanguageDescription 的两个 alias：搭 languagesToLoad 去重的正向证据。
  code('js'), code('javascript'),
  // 两个 LaTeX 块：一个有内容、一个没有——搭 nonEmptyLatexBlocks 只数非空那个的正向证据。
  code('LaTeX'), codeEmpty('LaTeX'),
  code('nosuchlang'), code(''),
  schema.node('image-block', { src: 'figs/a.png' }),
  schema.node('image-block', { src: '' }),
  schema.node('paragraph', null, [schema.text('t'), schema.node('image', { src: 'b.png' })]),
]);

describe('语言表：与 Crepe 的 LanguageLoader 同一规则（alias 小写匹配，alias 已含本名）', () => {
  it('认得别名与本名，不分大小写；认不得的返回 false', () => {
    expect(isKnownLanguage('js')).toBe(true);
    expect(isKnownLanguage('JavaScript')).toBe(true);
    expect(isKnownLanguage('LaTeX')).toBe(true);
    expect(isKnownLanguage('nosuchlang')).toBe(false);
    expect(isKnownLanguage('')).toBe(false);
  });

  it('languagesToLoad：文档里认得的去重后给出，对象就是 language-data 里那一个', () => {
    const got = languagesToLoad(doc);
    // 正向：js 与 javascript 各出现一次、LaTeX 出现两次，去重后仍然只剩两个语言对象——
    // 不是巧合出的数字（比如文档里本来就只有两种语言名）。
    expect(got.map((d) => d.name).sort()).toEqual(['JavaScript', 'LaTeX']);
    for (const d of got) expect(languages).toContain(d);
  });
});

describe('expectsDataLanguage（spec §3.4 第 3 条：只有加载出的 Language.name 非空才要求 data-language）', () => {
  it('还没 load() 完的语言按「要求」处理（宁可多等，也不在名字未知时提前放行）', () => {
    // python 是这份测试文件里别处不会加载的真实语言，用来搭「还没加载完」这个分支。
    expect(expectsDataLanguage('python')).toBe(true);
  });

  it('dockerfile 加载出的 Language.name 是空串，加载后不再要求；js 加载出的名字非空，加载后仍要求（正向，同条用例）', async () => {
    const find = (alias: string) => languages.find((l) => l.alias.includes(alias))!;
    await find('js').load();
    await find('dockerfile').load();
    expect(expectsDataLanguage('js')).toBe(true);
    expect(expectsDataLanguage('dockerfile')).toBe(false);
  });

  it('认不得的语言直接 false，不管有没有 load 过', () => {
    expect(expectsDataLanguage('nosuchlang')).toBe(false);
    expect(expectsDataLanguage('')).toBe(false);
  });
});

describe('factsFromDoc', () => {
  it('按文档顺序收代码块语言（含空串、含重复）；只数非空的 latex 块；只收 src 非空的图片节点（块级 + 行内）', () => {
    expect(factsFromDoc(doc)).toEqual({
      codeLanguages: ['js', 'javascript', 'LaTeX', 'LaTeX', 'nosuchlang', ''],
      imageNodeSrcs: ['figs/a.png', 'b.png'],
      // 正向：两个 LaTeX 块里只有一个有内容——不是「LaTeX 出现几次」就直接算
      nonEmptyLatexBlocks: 1,
    });
  });
});

describe('factsFromDom', () => {
  it('数占位、带 data-language 的 .cm-content、有内容的公式渲染区、src 非空的 img', () => {
    const els = (n: number, extra: Record<string, unknown> = {}) => Array.from({ length: n }, () => ({ ...extra }));
    const root = {
      querySelectorAll: (sel: string) => ({
        '.milkdown-code-block-placeholder': els(1),
        '.cm-content[data-language]': els(2),
        '.milkdown-code-block .preview-panel .preview': [{ childElementCount: 1 }, { childElementCount: 0 }],
        img: [{ getAttribute: () => 'file:///a.png', complete: true }, { getAttribute: () => '', complete: true }],
      } as Record<string, unknown[]>)[sel] ?? [],
    };
    expect(factsFromDom(root as never)).toEqual({
      placeholders: 1, taggedCodeContents: 2, latexPreviews: 1,
      imgs: [{ src: 'file:///a.png', complete: true }],
    });
  });
});

describe('isPrintReady', () => {
  const ready: PrintFacts = {
    codeLanguages: ['js', 'LaTeX', 'nosuchlang', ''], imageNodeSrcs: ['a', 'b'],
    nonEmptyLatexBlocks: 1,
    placeholders: 0, taggedCodeContents: 2, latexPreviews: 1,
    imgs: [{ src: 'a', complete: true }, { src: 'b', complete: true }],
  };
  it('全部成立 → true；任一条不成立 → false', () => {
    // 正向：这份事实就是「排好了」—— 下面每条 false 都只翻了一个字段
    expect(isPrintReady(ready)).toBe(true);
    expect(isPrintReady({ ...ready, placeholders: 1 })).toBe(false);
    expect(isPrintReady({ ...ready, taggedCodeContents: 1 })).toBe(false);   // js 或 LaTeX 还没挂上语言
    expect(isPrintReady({ ...ready, latexPreviews: 0 })).toBe(false);
    expect(isPrintReady({ ...ready, imgs: ready.imgs.slice(0, 1) })).toBe(false);   // 还有一张没出 img
    expect(isPrintReady({ ...ready, imgs: [ready.imgs[0], { src: 'b', complete: false }] })).toBe(false);
  });
  it('认不得的语言与空语言不要求 data-language（不然会一直等到 60 秒上限）', () => {
    expect(isPrintReady({
      ...ready, codeLanguages: ['nosuchlang', ''], taggedCodeContents: 0, latexPreviews: 0, nonEmptyLatexBlocks: 0,
    })).toBe(true);
  });
  it('latex 块内容为空则不要求 .preview；非空的仍要求（正向，同条用例，spec §3.4 第 4 条）', () => {
    // 空公式块：nonEmptyLatexBlocks 为 0，没有 .preview 也算排好了
    expect(isPrintReady({ ...ready, nonEmptyLatexBlocks: 0, latexPreviews: 0 })).toBe(true);
    // 正向：同一份事实，只要 nonEmptyLatexBlocks 变回 1（块里有内容），就重新要求 latexPreviews ≥ 1
    expect(isPrintReady({ ...ready, latexPreviews: 0 })).toBe(false);
  });
});

describe('isPrintableHref', () => {
  it('只留 http(s) 与 mailto；其余（javascript:、相对 md 链接、空）都不可印', () => {
    for (const ok of ['https://x.org', 'http://x.org/a', 'mailto:a@b.c', 'HTTPS://X.ORG']) expect(isPrintableHref(ok), ok).toBe(true);
    for (const no of ['javascript:alert(1)', 'other.md', '#sec', '', 'file:///etc/passwd']) expect(isPrintableHref(no), no).toBe(false);
  });
});
