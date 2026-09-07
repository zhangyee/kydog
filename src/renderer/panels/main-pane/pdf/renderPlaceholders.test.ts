import { describe, expect, it } from 'vitest';
import { splitPlaceholders } from './renderPlaceholders';

const ph = [{ id: 'v1', kind: 'citation' as const, text: '[12]' }];

describe('splitPlaceholders', () => {
  it('没有占位符 → 一段纯文本', () => {
    expect(splitPlaceholders('深度学习', [])).toEqual([{ kind: 'text', text: '深度学习' }]);
  });
  it('中间一个占位符 → 三段', () => {
    expect(splitPlaceholders('已经 {v1} 表明', ph)).toEqual([
      { kind: 'text', text: '已经 ' },
      { kind: 'citation', text: '[12]' },
      { kind: 'text', text: ' 表明' },
    ]);
  });
  it('同一个占位符出现两次都还原', () => {
    expect(splitPlaceholders('{v1}和{v1}', ph)).toHaveLength(3);
  });
  it('认不出的 {vN} 按字面量留着，不报错', () => {
    expect(splitPlaceholders('见 {v9}', ph)).toEqual([{ kind: 'text', text: '见 {v9}' }]);
  });
  it('开头和结尾的占位符不产生空文本段', () => {
    expect(splitPlaceholders('{v1}', ph)).toEqual([{ kind: 'citation', text: '[12]' }]);
  });
  it('placeholder 带 script → 段落带 script；不带的段落没有这个键', () => {
    const segs = splitPlaceholders('n{v1} 与 x{v2}', [
      { id: 'v1', kind: 'formula', text: 'i', script: 'sub' },
      { id: 'v2', kind: 'formula', text: '2', script: 'sup' },
    ]);
    expect(segs).toEqual([
      { kind: 'text', text: 'n' },
      { kind: 'formula', text: 'i', script: 'sub' },
      { kind: 'text', text: ' 与 x' },
      { kind: 'formula', text: '2', script: 'sup' },
    ]);
  });
});
