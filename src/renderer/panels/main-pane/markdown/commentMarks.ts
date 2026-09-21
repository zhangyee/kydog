import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/kit/prose/state';
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view';

/** 批注框开着时那条「待定」下划线的 id（裁定 7）。 */
export const PENDING_COMMENT_ID = '__pending__';

type Meta =
  | { type: 'add'; id: string; from: number; to: number }
  | { type: 'rename'; from: string; to: string }
  | { type: 'keep'; ids: ReadonlySet<string> };

export const commentMarksKey = new PluginKey<DecorationSet>('kydog-comment-marks');

const mark = (id: string, from: number, to: number) =>
  Decoration.inline(from, to, { class: 'kydog-comment-mark' }, { id });

/**
 * 被批注的句子留一条虚下划线（spec §2.5）。状态只活在这个编辑器实例里：关标签页、外部改动
 * 触发 Crepe 重建之后就没有了 —— 那是拍板的行为（只在这次打开期间显示），不是缺陷。
 * 每个事务按 mapping 映射；文字整段删掉时行内装饰自然映射为空、被丢掉。
 */
export function commentMarksPlugin(): Plugin {
  return new Plugin<DecorationSet>({
    key: commentMarksKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        let next = set.map(tr.mapping, tr.doc);
        const meta = tr.getMeta(commentMarksKey) as Meta | undefined;
        if (!meta) return next;
        if (meta.type === 'add') return next.add(tr.doc, [mark(meta.id, meta.from, meta.to)]);
        if (meta.type === 'rename') {
          const decos: any[] = [];
          let found = false;
          next.find(0, tr.doc.content.size).forEach((deco: any) => {
            if (deco.spec.id === meta.from) {
              decos.push(mark(meta.to, deco.from, deco.to));
              found = true;
            } else {
              decos.push(mark(deco.spec.id, deco.from, deco.to));
            }
          });
          if (!found) return next;
          return DecorationSet.empty.add(tr.doc, decos);
        }
        const keep: any[] = [];
        next.find(0, tr.doc.content.size).forEach((deco: any) => {
          if (meta.ids.has(deco.spec.id as string)) {
            keep.push(mark(deco.spec.id, deco.from, deco.to));
          }
        });
        return DecorationSet.empty.add(tr.doc, keep);
      },
    },
    props: { decorations: (state) => commentMarksKey.getState(state) },
  });
}

export function addCommentMark(tr: Transaction, id: string, from: number, to: number): Transaction {
  return tr.setMeta(commentMarksKey, { type: 'add', id, from, to } satisfies Meta);
}
export function renameCommentMark(tr: Transaction, fromId: string, toId: string): Transaction {
  return tr.setMeta(commentMarksKey, { type: 'rename', from: fromId, to: toId } satisfies Meta);
}
export function keepCommentMarks(tr: Transaction, ids: ReadonlySet<string>): Transaction {
  return tr.setMeta(commentMarksKey, { type: 'keep', ids } satisfies Meta);
}

export function commentMarkRanges(state: EditorState): Array<{ id: string; from: number; to: number }> {
  const set = commentMarksKey.getState(state) ?? DecorationSet.empty;
  return set.find().map((d) => ({ id: d.spec.id as string, from: d.from, to: d.to }));
}
