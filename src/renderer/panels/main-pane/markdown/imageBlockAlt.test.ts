import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Clock, Container, Ctx } from '@milkdown/kit/ctx';
import { imageBlockAltSchema, parseImageBlockAlt, serializeImageBlockAlt } from './imageBlockAlt';

describe('parseImageBlockAlt', () => {
  it('Milkdown 自己写出的比例格式（toFixed(2)）当比例', () => {
    expect(parseImageBlockAlt('1.50')).toEqual({ ratio: 1.5, alt: '' });
    expect(parseImageBlockAlt('0.75')).toEqual({ ratio: 0.75, alt: '' });
    expect(parseImageBlockAlt('1.00')).toEqual({ ratio: 1, alt: '' });
  });

  it('其余一律是说明文字，原样保留（「2023」「图 3」不会被误读成比例）', () => {
    for (const alt of ['块级图', '2023', '图 3', '1.5', '1.500', ' 1.50', 'Fig. 2', '0.00']) {
      expect(parseImageBlockAlt(alt), alt).toEqual({ ratio: 1, alt });
    }
  });

  it('没有 alt → 比例 1、空说明', () => {
    expect(parseImageBlockAlt(undefined)).toEqual({ ratio: 1, alt: '' });
    expect(parseImageBlockAlt(null)).toEqual({ ratio: 1, alt: '' });
    expect(parseImageBlockAlt('')).toEqual({ ratio: 1, alt: '' });
  });
});

describe('serializeImageBlockAlt', () => {
  it('有说明文字 → 写说明文字（哪怕拖过缩放：说明是内容，比例是外观）', () => {
    expect(serializeImageBlockAlt({ ratio: 1, alt: '块级图' })).toBe('块级图');
    expect(serializeImageBlockAlt({ ratio: 1.5, alt: '块级图' })).toBe('块级图');
  });

  it('没有说明文字：比例 ≠ 1 写比例，= 1 写空', () => {
    expect(serializeImageBlockAlt({ ratio: 1.5, alt: '' })).toBe('1.50');
    expect(serializeImageBlockAlt({ ratio: 1, alt: '' })).toBe('');
    expect(serializeImageBlockAlt({ ratio: Number.NaN, alt: '' })).toBe('');
  });

  it('读写往返：说明文字与比例各自稳定', () => {
    for (const alt of ['块级图', '2023', '1.50', '0.00', '']) {
      expect(serializeImageBlockAlt(parseImageBlockAlt(alt)), alt).toBe(alt === '1.00' ? '' : alt);
    }
  });
});

/** 扩展后节点的 spec：照 $nodeSchema 自己的走法，先跑它的 ctx 插件把 schema 函数放进 slice，再取出来调用。 */
async function imageBlockSpec() {
  const ctx = new Ctx(new Container(), new Clock());
  await imageBlockAltSchema.ctx(ctx)();
  return ctx.get(imageBlockAltSchema.key)(ctx);
}

/** node 环境没有 DOM；原规则的 getAttrs 先查 `dom instanceof HTMLElement`，给它一个只会 getAttribute 的替身。 */
class FakeElement {
  constructor(private readonly attrs: Record<string, unknown>) {}
  getAttribute(name: string): string | null {
    const v = this.attrs[name];
    return v === undefined ? null : String(v);   // DOM 属性一律是字符串
  }
}
const asDom = (attrs: Record<string, unknown>) => new FakeElement(attrs) as unknown as HTMLElement;

describe('imageBlockAltSchema 的 DOM 往返（编辑器里复制粘贴走这条路）', () => {
  beforeEach(() => { vi.stubGlobal('HTMLElement', FakeElement); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('toDOM 写出的 img，parseDOM 读回同一组属性：说明文字、比例、src、caption 各自翻面都在', async () => {
    const spec = await imageBlockSpec();
    const [rule] = spec.parseDOM ?? [];
    expect(rule.tag).toBe('img[data-type="image-block"]');
    for (const attrs of [
      { src: 'figs/a.png', caption: '标题', ratio: 1, alt: '图 3' },
      { src: 'figs/b.png', caption: '', ratio: 1.5, alt: '' },
    ]) {
      const [tag, domAttrs] = spec.toDOM!({ attrs } as never) as [string, Record<string, unknown>];
      expect(tag).toBe('img');
      expect(rule.getAttrs!(asDom(domAttrs)), JSON.stringify(attrs)).toEqual(attrs);
    }
  });

  it('别处来的 img 没有 alt 属性：说明文字读成空，其余照原规则', async () => {
    const [rule] = (await imageBlockSpec()).parseDOM ?? [];
    expect(rule.getAttrs!(asDom({ 'data-type': 'image-block', src: 'a.png' })))
      .toEqual({ src: 'a.png', caption: '', ratio: 1, alt: '' });
  });
});
