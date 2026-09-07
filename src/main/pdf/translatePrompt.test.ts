import { describe, it, expect } from 'vitest';
import {
  buildLayoutSystemPrompt, buildTranslateSystemPrompt, buildGroupsText, buildUserText, escapeCell, matchGlossary,
} from './translatePrompt';
import { BLOCK_KINDS } from '../../shared/zhSidecar';

const L = (n: number, text: string) => ({ n, x: 72.4, y: 89.6, w: 451.2, h: 11.8, size: 10.2, text });

describe('matchGlossary', () => {
  const g = [{ source: 'attention head', target: '注意力头' }, { source: 'beam search', target: '束搜索' }];
  it('只回命中本页原文的条目', () => {
    expect(matchGlossary(g, [L(1, 'Each attention head attends to')].map((l) => l.text))).toEqual([g[0]]);
  });
  it('大小写不敏感', () => {
    expect(matchGlossary(g, [L(1, 'Attention Head')].map((l) => l.text))).toEqual([g[0]]);
  });
  it('一条都没命中就是空数组', () => {
    expect(matchGlossary(g, [L(1, 'nothing here')].map((l) => l.text))).toEqual([]);
  });
});

describe('escapeCell', () => {
  it('竖线转义、换行与制表符变空格', () => {
    expect(escapeCell('a|b\nc\td')).toBe('a\\|b c d');
  });
});

describe('buildUserText', () => {
  it('每行 "n\\tx,y,w,h,size\\ttext"，几何取整', () => {
    expect(buildUserText([L(1, 'Deep learning')])).toBe('1\t72,90,451,12,10\tDeep learning');
  });
});

describe('buildLayoutSystemPrompt（第一步：只分组分类）', () => {
  const p = buildLayoutSystemPrompt({});
  it('kind 表与 BLOCK_KINDS 集合相等（七个）', () => {
    const table = p.slice(p.indexOf('kind is one of:'), p.indexOf('## Output format'));
    const kinds = [...table.matchAll(/^\s{3}([a-z]+)\s{2,}/gm)].map((m) => m[1]);
    expect(new Set(kinds)).toEqual(new Set(BLOCK_KINDS));
    expect(kinds).toHaveLength(BLOCK_KINDS.length);
  });
  it('点名页眉页码是行、坐标不是行号、框 / 等宽是一个块、首行缩进起新段', () => {
    expect(p).toContain('Running heads, page numbers and footers are lines');
    expect(p).toMatch(/never a\s+coordinate/);
    expect(p).toMatch(/boxed or monospace listing is one block/);
    expect(p).toMatch(/indented first line/);
  });
  it('输出格式是每组一行、没有译文；例子里有页码行归 skip', () => {
    expect(p).toContain('<line ids> | <kind>');
    expect(p).not.toContain('%%');
    expect(p).toContain('5\t303,740,5,10,10\t4');
    expect(p).toMatch(/\n5 \| skip/);
  });
  it('docTitle 缺省时没有 Context 段', () => {
    expect(p).not.toContain('## Context');
    expect(buildLayoutSystemPrompt({ docTitle: 'A Paper' })).toContain('The document is titled "A Paper"');
  });
});

describe('buildTranslateSystemPrompt（第二步：按组翻译）', () => {
  const groups = [{ id: 'g1', kind: 'text' as const, source: 'attention head is ...' }];
  it('语言名不是代码', () => {
    expect(buildTranslateSystemPrompt({ langOut: 'zh', groups })).toContain('professional Chinese native translator');
    expect(buildTranslateSystemPrompt({ langOut: 'en', groups })).toContain('professional English native translator');
  });
  it('逐句翻译、不省略、不合并组；%% 结束', () => {
    const p = buildTranslateSystemPrompt({ langOut: 'zh', groups });
    expect(p).toMatch(/Translate every group and every sentence/);
    expect(p).toMatch(/never summarize, never\s+omit, never merge/);
    expect(p).toContain('%%');
    expect(p).toContain('<group id>');
  });
  it('命中术语才出现 Glossary 段（按 groups 的 source 匹配）', () => {
    const glossary = [{ source: 'attention head', target: 'a|b' }, { source: 'zzz', target: 'z' }];
    const p = buildTranslateSystemPrompt({ langOut: 'zh', groups, glossary });
    expect(p).toContain('## Glossary');
    expect(p).toContain('| attention head | a\\|b |');
    expect(p).not.toContain('| zzz |');
  });
});

describe('buildGroupsText', () => {
  it('每组 `id | kind` 一行 + 原文，空行分隔', () => {
    expect(buildGroupsText([{ id: 'g1', kind: 'text', source: 'A b.' }, { id: 'g2', kind: 'title', source: '2 Method' }]))
      .toBe('g1 | text\nA b.\n\ng2 | title\n2 Method');
  });
});
