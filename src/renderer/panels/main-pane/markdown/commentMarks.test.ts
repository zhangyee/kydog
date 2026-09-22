import { describe, it, expect } from 'vitest';
import { Schema, type Node as PmNode } from '@milkdown/kit/prose/model';
import { EditorState } from '@milkdown/kit/prose/state';
import {
  commentMarksPlugin, addCommentMark, renameCommentMark, keepCommentMarks, commentMarkRanges, PENDING_COMMENT_ID,
} from './commentMarks';

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

function stateWith(text: string) {
  const doc = schema.node('doc', null, [p(t(text))]);
  return EditorState.create({ doc, plugins: [commentMarksPlugin()] });
}

describe('commentMarks —— 虚下划线随编辑移动', () => {
  it('前面插入文字：装饰整体后移、长度不变', () => {
    let s = stateWith('将 β 固定为 0.1，并复现。');
    const r = find(s.doc, '固定为 0.1');
    s = s.apply(addCommentMark(s.tr, 'c1', r.from, r.to));
    expect(commentMarkRanges(s)).toEqual([{ id: 'c1', from: r.from, to: r.to }]);
    s = s.apply(s.tr.insertText('【新】', 1));
    expect(commentMarkRanges(s)).toEqual([{ id: 'c1', from: r.from + 3, to: r.to + 3 }]);
  });

  it('被批注的文字整段删掉：装饰消失（先证明删之前在）', () => {
    let s = stateWith('将 β 固定为 0.1，并复现。');
    const r = find(s.doc, '固定为 0.1');
    s = s.apply(addCommentMark(s.tr, 'c1', r.from, r.to));
    expect(commentMarkRanges(s)).toHaveLength(1);
    s = s.apply(s.tr.delete(r.from, r.to));
    expect(commentMarkRanges(s)).toEqual([]);
  });

  it('待定 → 改名成真 id；keep 之外的全部去掉', () => {
    let s = stateWith('甲乙丙丁戊');
    s = s.apply(addCommentMark(s.tr, PENDING_COMMENT_ID, 1, 3));
    s = s.apply(addCommentMark(s.tr, 'c2', 4, 6));
    s = s.apply(renameCommentMark(s.tr, PENDING_COMMENT_ID, 'c1'));
    expect(commentMarkRanges(s).map((x) => x.id).sort()).toEqual(['c1', 'c2']);
    s = s.apply(keepCommentMarks(s.tr, new Set(['c2'])));
    expect(commentMarkRanges(s).map((x) => x.id)).toEqual(['c2']);
  });
});
