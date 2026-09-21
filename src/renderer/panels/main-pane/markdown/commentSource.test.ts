import { describe, it, expect } from 'vitest';
import { Schema, type Node as PmNode } from '@milkdown/kit/prose/model';
import { sectionAt, quoteOf } from './commentSource';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*', attrs: { level: { default: 1 } } },
    blockquote: { group: 'block', content: 'block+' },
    'image-block': { group: 'block', atom: true, attrs: { src: { default: '' }, caption: { default: '' } } },
    text: { group: 'inline' },
    math_inline: { group: 'inline', inline: true, atom: true, attrs: { value: { default: '' } } },
    image: { group: 'inline', inline: true, atom: true, attrs: { src: { default: '' }, alt: { default: '' } } },
    hardbreak: { group: 'inline', inline: true },
  },
});
const p = (...c: PmNode[]) => schema.node('paragraph', null, c);
const h = (level: number, s: string) => schema.node('heading', { level }, [schema.text(s)]);
const t = (s: string) => schema.text(s);
/** 在文档里找一段文字的起止位置（测试辅助）。 */
function find(doc: PmNode, needle: string): { from: number; to: number } {
  let hit: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (hit || !node.isText) return;
    const i = node.text!.indexOf(needle);
    if (i >= 0) hit = { from: pos + i, to: pos + i + needle.length };
  });
  if (!hit) throw new Error(`not found: ${needle}`);
  return hit;
}

describe('sectionAt —— 选区往前最近的标题', () => {
  const doc = schema.node('doc', null, [
    p(t('前言没有标题')),
    h(1, '第三章'),
    p(t('章首段')),
    h(2, '3.2 偏好对齐方法'),
    p(t('将 β 固定为 0.1')),
    schema.node('blockquote', null, [h(3, '引用里的标题'), p(t('引用段'))]),
    p(t('引用之后')),
  ]);
  it('取最近的那一个，不论级别；选区在标题里就是它自己；嵌在引用块里的标题也算', () => {
    expect(sectionAt(doc, find(doc, '固定').from)).toBe('3.2 偏好对齐方法');
    expect(sectionAt(doc, find(doc, '章首段').from)).toBe('第三章');
    expect(sectionAt(doc, find(doc, '偏好').from)).toBe('3.2 偏好对齐方法');
    expect(sectionAt(doc, find(doc, '引用之后').from)).toBe('引用里的标题');
  });
  it('往前没有标题：没有小节（先证明有标题时取得到）', () => {
    expect(sectionAt(doc, find(doc, '章首段').from)).toBe('第三章');
    expect(sectionAt(doc, find(doc, '前言').from)).toBeUndefined();
  });
});

describe('quoteOf —— 选区的纯文本快照', () => {
  it('跨段落时段落之间换行，首尾空白去掉', () => {
    const doc = schema.node('doc', null, [p(t('第一段 甲')), p(t('第二段 乙 '))]);
    expect(quoteOf(doc, find(doc, '甲').from, find(doc, '乙').to)).toBe('甲\n第二段 乙');
  });
  it('非文字节点代入源码：公式代 $LaTeX$、图片代 alt、硬换行代 \\n', () => {
    const doc = schema.node('doc', null, [p(
      t('设 '), schema.node('math_inline', { value: '\\beta' }), t(' 为'),
      schema.node('hardbreak'), t('见 '), schema.node('image', { alt: '图 3' }), t(' 末'),
    )]);
    expect(quoteOf(doc, 1, doc.content.size - 1)).toBe('设 $\\beta$ 为\n见 图 3 末');
  });
});
