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
  it('kind 表与 BLOCK_KINDS 集合相等、数目相等', () => {
    const table = p.slice(p.indexOf('kind is one of:'), p.indexOf('## Output format'));
    const kinds = [...table.matchAll(/^\s{3}([a-z]+)\s{2,}/gm)].map((m) => m[1]);
    expect(new Set(kinds)).toEqual(new Set(BLOCK_KINDS));
    expect(kinds).toHaveLength(BLOCK_KINDS.length);
  });
  it('点名页眉页码是行、坐标不是行号、框 / 等宽是一个块、首行缩进起新段', () => {
    expect(p).toContain('Running heads, page numbers and footers are lines');
    expect(p).toMatch(/never a\s+coordinate/);
    expect(p).toMatch(/boxed or monospace listing is one block/);
    // 标题页的作者 / 单位 / 邮箱归 skip：它们不是散文，四栏网格也没法在译文里重排（Yee 2026-09-07 手测：
    // 单步协议那一版把它们译成一段流水文，格式全乱）。规则句与 kind 表两处都要有。
    expect(p).toMatch(/Author names, affiliations and e-mail\s+addresses on the title page are skip too/);
    expect(p).toMatch(/author names \/ affiliations \/ e-mail lines on the title page/);
    // 图里的文字（案例框、流程图标签、截图）归 figure，哪怕是整句：Yee 2026-09-07 手测第 12 页的
    // Figure 8 案例框被当正文译成一团。规则句与 kind 表两处都要有。
    expect(p).toMatch(/is figure content, not prose/);
    expect(p).toMatch(/^\s{3}figure\s{2,}text that belongs to a figure/m);
    expect(p).toMatch(/indented first line/);
  });
  it('输出格式是每组一行、没有译文；例子里有页码行归 skip', () => {
    expect(p).toContain('<line ids> | <kind>');
    expect(p).not.toContain('%%');
    expect(p).toContain('5\t303,740,5,10,10\t4');
    expect(p).toMatch(/\n5 \| skip/);
  });
  it('跨栏续段是两组：规则句点名，例子里左栏底的 6 与右栏顶的 7 各成一组（2512.03413 第 5 页）', () => {
    expect(p).toMatch(/continues at the top\s+of the next column is two groups, one per column/);
    expect(p).toContain('6\t72,660,220,12,10\t');
    expect(p).toContain('7\t312,90,220,12,10\t');
    expect(p).toContain('\n6 | text\n7 | text\n');
  });
  it('说明显式行号优先于范围（spec 2026-09-07 §8.2）', () => {
    expect(p).toContain('If an id you list on its own also falls inside a range you wrote, the range is read as excluding it.');
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
  it('数学符号逐字照抄、禁止改写成 LaTeX（2512.03413 第 5 页把 𝑣𝑛 写成了 \\( v_n \\)）', () => {
    const p = buildTranslateSystemPrompt({ langOut: 'zh', groups });
    expect(p).toMatch(/copied character for character/);
    expect(p).toMatch(/never rewrite\s+them as LaTeX/);
    expect(p).toContain('𝑣𝑛 stays 𝑣𝑛');
  });
  it('命中术语才出现 Glossary 段（按 groups 的 source 匹配）', () => {
    const glossary = [{ source: 'attention head', target: 'a|b' }, { source: 'zzz', target: 'z' }];
    const p = buildTranslateSystemPrompt({ langOut: 'zh', groups, glossary });
    expect(p).toContain('## Glossary');
    expect(p).toContain('| attention head | a\\|b |');
    expect(p).not.toContain('| zzz |');
  });
  it('任一组含 {vN} → 插入记号规则为第 4 条，%% 那条顺延为第 5 条（spec 2026-09-07 scripts §5.1）', () => {
    const p = buildTranslateSystemPrompt({ langOut: 'zh', groups: [{ id: 'g1', kind: 'text', source: 'node n{v1} in' }, { id: 'g2', kind: 'text', source: 'plain' }] });
    expect(p).toContain('4. The text may contain placeholder tokens such as {v1}, {v2}.');
    expect(p).toContain('exactly once, unchanged, attached to the same symbol it follows');
    expect(p).toContain('5. Never emit a line that is exactly "%%"');
    expect(p).not.toContain('4. Never emit a line');
  });
  it('没有记号 → 没有那条规则，%% 仍是第 4 条（提示词与今天逐字相同）', () => {
    const p = buildTranslateSystemPrompt({ langOut: 'zh', groups: [{ id: 'g1', kind: 'text', source: 'plain { v1 }' }] });
    expect(p).not.toContain('placeholder tokens');
    expect(p).toContain('4. Never emit a line that is exactly "%%"');
  });
});

describe('buildGroupsText', () => {
  it('每组 `id | kind` 一行 + 原文，空行分隔', () => {
    expect(buildGroupsText([{ id: 'g1', kind: 'text', source: 'A b.' }, { id: 'g2', kind: 'title', source: '2 Method' }]))
      .toBe('g1 | text\nA b.\n\ng2 | title\n2 Method');
  });
});
