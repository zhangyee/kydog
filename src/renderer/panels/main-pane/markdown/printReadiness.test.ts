import { describe, it, expect } from 'vitest';
import { Schema } from '@milkdown/kit/prose/model';
import { languages } from '@codemirror/language-data';
import {
  isKnownLanguage, languagesToLoad, factsFromDoc, factsFromDom, isPrintReady, isPrintableHref, type PrintFacts,
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
const doc = schema.node('doc', null, [
  code('js'), code('LaTeX'), code('nosuchlang'), code(''),
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
    expect(got.map((d) => d.name).sort()).toEqual(['JavaScript', 'LaTeX']);
    for (const d of got) expect(languages).toContain(d);
  });
});

describe('factsFromDoc', () => {
  it('按文档顺序收代码块语言（含空串）；只收 src 非空的图片节点（块级 + 行内）', () => {
    expect(factsFromDoc(doc)).toEqual({
      codeLanguages: ['js', 'LaTeX', 'nosuchlang', ''],
      imageNodeSrcs: ['figs/a.png', 'b.png'],
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
    expect(isPrintReady({ ...ready, codeLanguages: ['nosuchlang', ''], taggedCodeContents: 0, latexPreviews: 0 })).toBe(true);
  });
});

describe('isPrintableHref', () => {
  it('只留 http(s) 与 mailto；其余（javascript:、相对 md 链接、空）都不可印', () => {
    for (const ok of ['https://x.org', 'http://x.org/a', 'mailto:a@b.c', 'HTTPS://X.ORG']) expect(isPrintableHref(ok), ok).toBe(true);
    for (const no of ['javascript:alert(1)', 'other.md', '#sec', '', 'file:///etc/passwd']) expect(isPrintableHref(no), no).toBe(false);
  });
});
