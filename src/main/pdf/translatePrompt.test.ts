import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildUserText, escapeCell, matchGlossary } from './translatePrompt';

const L = (n: number, text: string) => ({ n, x: 72.4, y: 89.6, w: 451.2, h: 11.8, size: 10.2, text });

describe('matchGlossary', () => {
  const g = [{ source: 'attention head', target: '注意力头' }, { source: 'beam search', target: '束搜索' }];
  it('只回命中本页原文的条目', () => {
    expect(matchGlossary(g, [L(1, 'Each attention head attends to')])).toEqual([g[0]]);
  });
  it('大小写不敏感', () => {
    expect(matchGlossary(g, [L(1, 'Attention Head')])).toEqual([g[0]]);
  });
  it('一条都没命中就是空数组', () => {
    expect(matchGlossary(g, [L(1, 'nothing here')])).toEqual([]);
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

describe('buildSystemPrompt', () => {
  const lines = [L(1, 'Each attention head attends to')];
  it('目标语言进提示词', () => {
    expect(buildSystemPrompt({ langOut: 'zh', lines })).toContain('professional zh native translator');
  });
  it('命中术语才出现 Glossary 段，且用转义后的值', () => {
    const p = buildSystemPrompt({ langOut: 'zh', lines, glossary: [{ source: 'attention|head', target: '注意力头' }] });
    expect(p).not.toContain('## Glossary');       // 没命中
    const q = buildSystemPrompt({ langOut: 'zh', lines, glossary: [{ source: 'attention head', target: 'a|b' }] });
    expect(q).toContain('## Glossary');
    expect(q).toContain('| attention head | a\\|b |');
  });
  it('docTitle 缺省时没有 Context 段', () => {
    expect(buildSystemPrompt({ langOut: 'zh', lines })).not.toContain('## Context');
    expect(buildSystemPrompt({ langOut: 'zh', lines, docTitle: 'A Paper' })).toContain('The document is titled "A Paper"');
  });
  it('六个 kind 与输出格式都在提示词里', () => {
    const p = buildSystemPrompt({ langOut: 'zh', lines });
    for (const k of ['text', 'title', 'caption', 'formula', 'table', 'skip']) expect(p).toContain(k);
    expect(p).toContain('%%');
  });
});
