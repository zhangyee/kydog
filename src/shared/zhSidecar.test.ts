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
