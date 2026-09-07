import { describe, it, expect } from 'vitest';
import { PLACEHOLDER_TOKEN, type PageLine } from '../../../../shared/zhSidecar';
import { buildBlocks, tokenize } from './buildBlocks';

const line = (n: number, x: number, y: number, w: number, size: number, text: string): PageLine =>
  ({ n, x, y, w, h: size, size, text });

describe('buildBlocks', () => {
  const lines = [
    line(1, 72, 90, 400, 10, 'Deep learning has'),
    line(2, 72, 104, 380, 10, 'shown results.'),
    line(3, 72, 130, 120, 14, '2 Method'),
  ];

  it('bbox 取并集，id 按最小行号升序编', () => {
    const out = buildBlocks(3, lines, [
      { lines: [3], kind: 'title', target: '2 方法' },
      { lines: [1, 2], kind: 'text', target: '深度学习已展现出结果。' },
    ]);
    expect(out.map((b) => b.id)).toEqual(['p3-b01', 'p3-b02']);
    expect(out[0]).toMatchObject({ page: 3, x: 72, y: 90, width: 400, height: 24, kind: 'text' });
    expect(out[1]).toMatchObject({ x: 72, y: 130, width: 120, height: 14, kind: 'title' });
  });

  it('fontSize 取中位数：奇数取中间，偶数取较小的那个', () => {
    const l = [line(1, 0, 0, 10, 10, 'a'), line(2, 0, 20, 10, 12, 'b'), line(3, 0, 40, 10, 20, 'c')];
    expect(buildBlocks(1, l, [{ lines: [1, 2, 3], kind: 'text', target: 'x' }])[0].fontSize).toBe(12);
    expect(buildBlocks(1, l, [{ lines: [1, 2], kind: 'text', target: 'x' }])[0].fontSize).toBe(10);
  });

  it('source 按模型给出的顺序拼，不排序', () => {
    const out = buildBlocks(1, lines, [{ lines: [2, 1], kind: 'text', target: 'x' }]);
    expect(out[0].source).toBe('shown results. Deep learning has');
  });

  it('行尾连字符 + 下一行小写开头 → 去掉连字符直接连；否则空格连', () => {
    const l = [line(1, 0, 0, 10, 10, 'trans-'), line(2, 0, 20, 10, 10, 'lation works'), line(3, 0, 40, 10, 10, 'Next')];
    expect(buildBlocks(1, l, [{ lines: [1, 2, 3], kind: 'text', target: 'x' }])[0].source)
      .toBe('translation works Next');
  });

  it('不可译的 kind 不写 target', () => {
    const out = buildBlocks(1, lines, [{ lines: [3], kind: 'formula' }]);
    expect(out[0].target).toBeUndefined();
    expect('target' in out[0]).toBe(false);
  });

  it('行号在这一页找不到的组被跳过（防御，正常不会发生）', () => {
    expect(buildBlocks(1, lines, [{ lines: [99], kind: 'text', target: 'x' }])).toEqual([]);
  });

  it('块的 ink 取组内各行墨迹的并集；没有度量的行按字身框参与', () => {
    const lines = [
      { n: 1, x: 72, y: 100, w: 400, h: 10, size: 10, text: 'a', inkTop: 102.8, inkBottom: 112.2 },
      { n: 2, x: 72, y: 112, w: 400, h: 10, size: 10, text: 'b' },
    ];
    const [b] = buildBlocks(1, lines, [{ lines: [1, 2], kind: 'text', target: 'T' }]);
    expect(b.ink).toEqual({ top: 102.8, bottom: 122 });     // 第 2 行按 y + h = 122
    expect(b.y).toBe(100); expect(b.height).toBe(22);        // 字身框并集不变
  });
});

describe('tokenize（spec 2026-09-07 scripts §3.1）', () => {
  const sub = (n: number, text: string, start: number, end: number): PageLine =>
    ({ ...line(n, 72, 90 + n * 14, 400, 10, text), scripts: [{ start, end, kind: 'sub' }] });

  it('区间换成 {vN}，组内从 v1 起按文本顺序编号；source 是去记号的串；placeholders 带 script', () => {
    const t = tokenize([sub(1, 'node ni is', 6, 7), line(2, 72, 118, 400, 10, 'plain'), sub(3, 'set Vj', 5, 6)]);
    expect(t.request).toBe('node n{v1} is plain set V{v2}');
    expect(t.source).toBe('node ni is plain set Vj');
    expect(t.placeholders).toEqual([
      { id: 'v1', kind: 'formula', text: 'i', script: 'sub' },
      { id: 'v2', kind: 'formula', text: 'j', script: 'sub' },
    ]);
  });
  it('构造性不变量：request 里的记号换回 text 就是 source', () => {
    const t = tokenize([sub(1, 'a bc-', 3, 5), line(2, 72, 118, 400, 10, 'tail')]);
    const byId = new Map(t.placeholders.map((p) => [p.id, p.text]));
    expect(t.request.replace(PLACEHOLDER_TOKEN, (m, id: string) => byId.get(id) ?? m)).toBe(t.source);
  });
  it('没有脚标 → request === source，placeholders 为空，与 joinSource 逐字相同', () => {
    const ls = [line(1, 0, 0, 10, 10, 'trans-'), line(2, 0, 20, 10, 10, 'lation works')];
    const t = tokenize(ls);
    expect(t.request).toBe('translation works');
    expect(t.source).toBe(t.request);
    expect(t.placeholders).toEqual([]);
  });
  it('一行里多个区间、sub 与 sup 混排', () => {
    const l: PageLine = { ...line(1, 0, 0, 10, 10, 'x2 and yi'), scripts: [{ start: 1, end: 2, kind: 'sup' }, { start: 8, end: 9, kind: 'sub' }] };
    const t = tokenize([l]);
    expect(t.request).toBe('x{v1} and y{v2}');
    expect(t.placeholders.map((p) => p.script)).toEqual(['sup', 'sub']);
  });
  it('组内正文字面含 {v1} 且有一个脚标 → 编号跳过撞车的 id，request 里字面原样保留，source 逐字等于原文', () => {
    const l: PageLine = { ...line(1, 0, 0, 10, 10, 'xi see literal {v1} tail'), scripts: [{ start: 1, end: 2, kind: 'sub' }] };
    const t = tokenize([l]);
    expect(t.placeholders).toEqual([{ id: 'v2', kind: 'formula', text: 'i', script: 'sub' }]);
    expect(t.request).toBe('x{v2} see literal {v1} tail');
    expect(t.source).toBe(l.text);
  });
  it('正文字面含 {v2}、组内有两个脚标 → 两个脚标拿到的 id 都不是 v2', () => {
    const t = tokenize([sub(1, 'node ni is {v2} literal', 6, 7), sub(2, 'set Vj here', 5, 6)]);
    expect(t.placeholders.map((p) => p.id)).toEqual(['v1', 'v3']);
    expect(t.request).toContain('{v2}');
  });
});

describe('buildBlocks 与 tokenize（spec §3.2）', () => {
  const ls: PageLine[] = [
    { ...line(1, 72, 90, 400, 10, 'node ni is'), scripts: [{ start: 6, end: 7, kind: 'sub' }] },
    line(2, 72, 104, 380, 10, 'plain.'),
  ];
  it('source 是明文；有 target 的块带 placeholders', () => {
    const [b] = buildBlocks(1, ls, [{ lines: [1, 2], kind: 'text', target: '节点 n{v1} 是平的。' }]);
    expect(b.source).toBe('node ni is plain.');
    expect(b.placeholders).toEqual([{ id: 'v1', kind: 'formula', text: 'i', script: 'sub' }]);
  });
  it('没有 target 的块（不可译 kind）不带 placeholders 键', () => {
    const [b] = buildBlocks(1, ls, [{ lines: [1, 2], kind: 'formula' }]);
    expect('placeholders' in b).toBe(false);
  });
  it('有 target 但没有脚标 → 不带 placeholders 键', () => {
    const [b] = buildBlocks(1, ls, [{ lines: [2], kind: 'text', target: '平的。' }]);
    expect('placeholders' in b).toBe(false);
  });
});
