import { describe, it, expect } from 'vitest';
import { extractPageLines } from './extractPageLines';

const vp = { convertToViewportPoint: (x: number, y: number) => [x, 400 - y] };
const item = (str: string, x: number, y: number, hasEOL: boolean) =>
  ({ str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, height: 10, hasEOL });

describe('extractPageLines', () => {
  it('抽出行并编号', async () => {
    const proxy = {
      getTextContent: async () => ({ items: [item('hello', 72, 300, true), item('world', 72, 286, true)] }),
      getViewport: () => vp,
    };
    const { lines } = await extractPageLines(proxy);
    expect(lines.map((l) => [l.n, l.text])).toEqual([[1, 'hello'], [2, 'world']]);
  });

  it('没有文本项 → 空数组（这是「这页没字」，不是错误）', async () => {
    const { lines } = await extractPageLines({ getTextContent: async () => ({ items: [] }), getViewport: () => vp });
    expect(lines).toEqual([]);
  });

  it('getTextContent 抛错 → 原样往外抛，不吞成空数组', async () => {
    const proxy = { getTextContent: async () => { throw new Error('worker died'); }, getViewport: () => vp };
    await expect(extractPageLines(proxy)).rejects.toThrow('worker died');
  });
});
