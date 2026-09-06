import { describe, expect, it } from 'vitest';
import { validateTranslatedDoc, filterByGeometry, type Block } from './zhSidecar';

const block = (over: Partial<Block> = {}): Block => ({
  id: 'p1-b01', page: 1, x: 72, y: 100, width: 451, height: 62,
  fontSize: 10, kind: 'text', source: 'hello', target: '你好', ...over,
});
const doc = (over: Record<string, unknown> = {}) => ({
  version: 1, pdf: 'paper.pdf', lang: { in: 'en', out: 'zh' }, blocks: [block()], ...over,
});

describe('validateTranslatedDoc', () => {
  it('最小合法文档通过', () => {
    expect(validateTranslatedDoc(doc(), 'f.json').blocks).toHaveLength(1);
  });

  it('target 可缺省 —— 缺省就是「不翻译这一块」', () => {
    const d = validateTranslatedDoc(doc({ blocks: [block({ target: undefined, kind: 'formula' })] }), 'f.json');
    expect(d.blocks[0].target).toBeUndefined();
  });

  it('版本不认识 → 抛，message 带实际版本', () => {
    expect(() => validateTranslatedDoc(doc({ version: 2 }), 'f.json')).toThrowError(/version.*2/);
  });

  it('blocks 不是数组 → 抛', () => {
    expect(() => validateTranslatedDoc(doc({ blocks: {} }), 'f.json')).toThrowError(/blocks/);
  });

  it('块缺字段 → 抛，message 指出第几条与哪个字段', () => {
    expect(() => validateTranslatedDoc(doc({ blocks: [block(), { ...block(), fontSize: 'big' }] }), 'f.json'))
      .toThrowError(/第 2 条.*fontSize/);
  });

  it('宽高非正 → 抛', () => {
    expect(() => validateTranslatedDoc(doc({ blocks: [block({ width: 0 })] }), 'f.json')).toThrowError(/width/);
  });

  it('page < 1 → 抛（边车与标注边车一样从 1 起）', () => {
    expect(() => validateTranslatedDoc(doc({ blocks: [block({ page: 0 })] }), 'f.json')).toThrowError(/page/);
  });

  it('占位符集合不一致不算错误 —— 逐块降级由渲染层做', () => {
    const d = doc({ blocks: [block({ target: '你好 {v9}', placeholders: [{ id: 'v1', kind: 'citation', text: '[1]' }] })] });
    expect(() => validateTranslatedDoc(d, 'f.json')).not.toThrow();
  });

  // 边车的唯一写入方是 agent，而这个校验是「一条不认识就拒整份文件」。错误信息只说「不认识
  // （paragraph）」的话，agent 从错误里学不到该写什么，只能瞎猜——把合法取值列进去，它就能
  // 自我修正。这两条同时钉住「取值集合确实是这六个 / 这三个」，抄错也会红。
  it('kind 不认识 → 抛，且 message 列出全部合法取值', () => {
    const d = doc({ blocks: [block({ kind: 'paragraph' as unknown as Block['kind'] })] });
    const run = () => validateTranslatedDoc(d, 'f.json');
    expect(run).toThrowError(/kind 不认识（paragraph）/);
    expect(run).toThrowError(/text \/ title \/ caption \/ formula \/ table \/ skip/);
  });

  it('placeholder 的 kind 不认识 → 抛，且 message 列出全部合法取值', () => {
    const d = doc({
      blocks: [block({ placeholders: [{ id: 'v1', kind: 'figure' as never, text: '[1]' }] })],
    });
    const run = () => validateTranslatedDoc(d, 'f.json');
    expect(run).toThrowError(/placeholders/);
    expect(run).toThrowError(/formula \/ citation \/ inline-code/);
  });

  it('source 摘要原样带出来', () => {
    const d = validateTranslatedDoc(doc({ source: { sha256: 'abc', bytes: 10 } }), 'f.json');
    expect(d.source).toEqual({ sha256: 'abc', bytes: 10 });
  });
});

describe('filterByGeometry', () => {
  const sizes = [{ w: 595, h: 842 }, { w: 595, h: 842 }];

  it('都在页内则一条不丢', () => {
    expect(filterByGeometry([block(), block({ page: 2 })], sizes)).toEqual({
      blocks: [block(), block({ page: 2 })], dropped: 0,
    });
  });

  it('page 超出总页数 → 丢弃并计数', () => {
    const r = filterByGeometry([block(), block({ page: 9 })], sizes);
    expect(r.blocks).toHaveLength(1);
    expect(r.dropped).toBe(1);
  });

  it('bbox 越出页面右下 → 丢弃', () => {
    expect(filterByGeometry([block({ x: 500, width: 200 })], sizes).dropped).toBe(1);
    expect(filterByGeometry([block({ y: 800, height: 100 })], sizes).dropped).toBe(1);
  });

  it('bbox 负坐标 → 丢弃', () => {
    expect(filterByGeometry([block({ x: -1 })], sizes).dropped).toBe(1);
  });
});

describe('glossary 结构校验', () => {
  const base = { version: 1, pdf: 'p.pdf', lang: { in: 'auto', out: 'zh' }, blocks: [] };
  it('没有 glossary 的旧边车照常通过', () => {
    expect(validateTranslatedDoc(base, 'f').glossary).toBeUndefined();
  });
  it('合法 glossary 通过', () => {
    const d = validateTranslatedDoc({ ...base, glossary: [{ source: 'attention head', target: '注意力头' }] }, 'f');
    expect(d.glossary).toEqual([{ source: 'attention head', target: '注意力头' }]);
  });
  it.each([
    ['不是数组', { glossary: {} }],
    ['项是 null', { glossary: [null] }],
    ['缺 target', { glossary: [{ source: 'a' }] }],
    ['source 是空串', { glossary: [{ source: '', target: 'b' }] }],
    ['target 不是字符串', { glossary: [{ source: 'a', target: 3 }] }],
  ])('%s → pdf.translation_invalid', (_name, patch) => {
    expect(() => validateTranslatedDoc({ ...base, ...patch }, 'f'))
      .toThrow(expect.objectContaining({ code: 'pdf.translation_invalid' }));
  });
});

describe('failedPages 结构校验', () => {
  const base = { version: 1, pdf: 'p.pdf', lang: { in: 'auto', out: 'zh' }, blocks: [] };
  it('没有 failedPages 的边车照常通过（不 bump version，同 glossary 当年那次）', () => {
    expect(validateTranslatedDoc(base, 'f').failedPages).toBeUndefined();
  });
  it('合法页号原样带出来——下游（Notice）要靠它，不是靠从 blocks 反推', () => {
    // 反推不成立：零行页与扫描空白页同样没有块，跟失败页混在一起分不开。所以边车必须显式记。
    const d = validateTranslatedDoc({ ...base, failedPages: [2, 7] }, 'f');
    expect(d.failedPages).toEqual([2, 7]);
  });
  it.each([
    ['不是数组', { failedPages: 3 }],
    ['项不是数字', { failedPages: ['2'] }],
    ['页号从 0 起', { failedPages: [0] }],
    ['负页号', { failedPages: [-1] }],
    ['小数页号', { failedPages: [1.5] }],
    ['NaN', { failedPages: [Number.NaN] }],
  ])('%s → pdf.translation_invalid', (_name, patch) => {
    expect(() => validateTranslatedDoc({ ...base, ...patch }, 'f'))
      .toThrow(expect.objectContaining({ code: 'pdf.translation_invalid' }));
  });
});

describe('failureReasons 结构校验', () => {
  const fdoc = (failureReasons: unknown) => ({ ...doc(), failedPages: [4], failureReasons });
  it('合法 → 原样带出', () => {
    expect(validateTranslatedDoc(fdoc({ '4': '行 59 没有出现在任何组里' }), 'f').failureReasons).toEqual({ '4': '行 59 没有出现在任何组里' });
  });
  it('不是对象 / 是数组 → 抛', () => {
    expect(() => validateTranslatedDoc(fdoc('x'), 'f')).toThrow(/failureReasons 不是对象/);
    expect(() => validateTranslatedDoc(fdoc(['a']), 'f')).toThrow(/failureReasons 不是对象/);
  });
  it('键不是 ≥ 1 的整数页号 → 抛', () => {
    expect(() => validateTranslatedDoc(fdoc({ '0': 'a' }), 'f')).toThrow(/不是 ≥ 1 的整数页号/);
    expect(() => validateTranslatedDoc(fdoc({ p4: 'a' }), 'f')).toThrow(/不是 ≥ 1 的整数页号/);
  });
  it('值为空串 → 抛', () => {
    expect(() => validateTranslatedDoc(fdoc({ '4': '' }), 'f')).toThrow(/不是非空字符串/);
  });
});
