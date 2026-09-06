import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildUserText, escapeCell, matchGlossary } from './translatePrompt';
import { BLOCK_KINDS } from '../../shared/zhSidecar';
import { TRANSLATABLE } from '../../renderer/panels/main-pane/pdf/parseGroups';

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
  it('提示词里是语言名不是语言代码', () => {
    // 'zh' / 'en' 是 settings.ui.locale 的取值，模型没理由认得；这条钉的就是「代号已经被
    // 换成语言名」——写回 ${o.langOut} 时它会红在这两行上。
    expect(buildSystemPrompt({ langOut: 'zh', lines })).toContain('professional Chinese native translator');
    expect(buildSystemPrompt({ langOut: 'en', lines })).toContain('professional English native translator');
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
  it('输出格式的 %% 在提示词里', () => {
    expect(buildSystemPrompt({ langOut: 'zh', lines })).toContain('%%');
  });

  it('规则 1 点名页眉页码页脚也是行、行号不是坐标；例子里有一行页码归 skip', () => {
    const p = buildSystemPrompt({ langOut: 'zh', lines });
    expect(p).toContain('Running heads, page numbers and footers are lines');
    expect(p).toMatch(/never a\s+coordinate/);
    expect(p).toContain('5\t303,740,5,10,10\t4');
    expect(p).toContain('5 | skip\n%%');
  });

  /**
   * 提示词里那份 kind 表是**英文散文硬编码**的，`BLOCK_KINDS` 加第七个值时它不会有任何信号：
   * 模型永远不知道新 kind 存在，而 parseGroups 的 KINDS 已经认了它。同 AGENTS.md 那份契约
   * （templates.test.ts）、src/about ↔ e2e/39、vite.main.config ↔ forge.config，是同一形状的
   * 漂移，这里按同样的办法补守卫。
   *
   * 判据是**集合相等 + 条数相等**，不是「每一项都出现过」：只断言包含的话，`BLOCK_KINDS` 删掉
   * 一个值时提示词里留下的那条多余说明照样全绿，漂移只守住了一个方向。
   */
  it('提示词的 kind 表与 BLOCK_KINDS 集合相等', () => {
    const p = buildSystemPrompt({ langOut: 'zh', lines });
    const m = /^4\. kind is one of:\n((?: {3}\S+ +\S.*\n)+)/m.exec(p);
    expect(m, '提示词里 "4. kind is one of:" 那张表找不到了').not.toBeNull();
    const listed = m![1].trimEnd().split('\n').map((l) => l.trim().split(/\s+/)[0]);
    expect(new Set(listed), '提示词的 kind 表与 BLOCK_KINDS 不一致').toEqual(new Set(BLOCK_KINDS));
    expect(listed, '提示词的 kind 表条数与 BLOCK_KINDS 不一致（有重复？）').toHaveLength(BLOCK_KINDS.length);
  });

  /**
   * 第二处漂移：翻译规则 1 那两串 kind。它同时是 parseGroups 的 `TRANSLATABLE` 与**它的隐式
   * 补集**在提示词里的说法——parseGroups 按 `else` 分派，补集没有第二张表，加第七个 kind 时
   * 它会静默变成「不可译」，而提示词那句话仍只列着六个中的三个。
   *
   * 两串都从同一份判据现推，所以 `TRANSLATABLE` 增删、或 `BLOCK_KINDS` 多一个值，都会在这里红。
   * 断言前把提示词的空白归一化：那两句在源码里折了行，不归一化就变成钉住排版而不是钉住内容。
   */
  it('翻译规则 1 的两串 kind 与 parseGroups 的 TRANSLATABLE 及其补集一致', () => {
    const flat = buildSystemPrompt({ langOut: 'zh', lines }).replace(/\s+/g, ' ');
    const list = (ks: readonly string[]) =>
      (ks.length === 1 ? ks[0] : `${ks.slice(0, -1).join(', ')} or ${ks[ks.length - 1]}`);
    const yes = BLOCK_KINDS.filter((k) => TRANSLATABLE.has(k));
    const no = BLOCK_KINDS.filter((k) => !TRANSLATABLE.has(k));
    expect(flat, '「必须有译文」那串 kind 与 TRANSLATABLE 不一致')
      .toContain(`Every group whose kind is ${list(yes)} MUST have a non-empty translation.`);
    expect(flat, '「必须没有译文」那串 kind 与 TRANSLATABLE 的补集不一致')
      .toContain(`Groups whose kind is ${list(no)} MUST have none.`);
  });
});
