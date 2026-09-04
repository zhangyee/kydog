import { usePdfAnnotationStore } from './pdfAnnotationStore';
import type { Note } from '../../../../shared/pdfSidecar';

/**
 * 文字注 textarea 的未提交草稿，按 note id 存。
 *
 * 为什么是模块级而不是 store：草稿要活过 NoteBox 的卸载（缩放顶替会整层重挂、虚拟化会把页逐出），
 * 但它还不是「已提交的内容」——进 store 就等于进撤销栈、进自动保存，每敲一个字压一份快照。
 *
 * 代价是它不在任何一条落盘链路上，所以关 tab 时必须显式 flushDrafts()：
 * PdfFileTab 卸载时冲的是 store 里的 doc，草稿不在里面。
 */
export const noteDrafts = new Map<string, string>();

/**
 * 刚落下、还没提交过的笔记：NoteBox（PdfAnnotationLayer.tsx）挂载时若在这张表里就自动聚焦，
 * 但不进选中态——选中会弹出改样式浮条，插入时不该弹，第二次点它才弹（用户反馈 5，与高亮笔
 * 一致）。和 noteDrafts 同样放模块级、同样的理由：要活过缩放顶替的整层重挂，又不是「已提交」
 * 的东西，不能放 store。放在这个文件而不是 PdfAnnotationLayer.tsx，是为了让 flushDrafts 也
 * 够得着它，不必反向 import 组件文件。
 */
export const noteAutoFocus = new Set<string>();

/**
 * 把该 tab 名下所有 note 的草稿提交进 store。只在关 tab / 卸载前调。
 *
 * 三个分支与 NoteBox 的 `commit()`（失焦路径）逐条对齐——同一份草稿走哪条路出去，结果必须一样：
 * 清空一条已提交过的笔记 = 删除（可撤销）、清空一条从未提交过的 = 放弃（不入撤销栈）、其余是改文本。
 * 只保留最后一条的话，用户清空一条已有笔记后**不失焦**地关 tab（Cmd+W / beforeunload 路径），
 * 边车里会留下一条 `text: ''` 的隐形笔记，而不是把它删掉。
 *
 * 同样对齐 commit() 的还有 noteAutoFocus：交代过一次之后就不再是「刚落下的新框」，别再抢焦点
 * ——否则不失焦的关 tab 路径会让这条 id 永远留在 noteAutoFocus 里，同一会话内重开同一份 PDF
 * 时这条 note 会莫名其妙自动抢焦点。
 */
export function flushDrafts(tabId: string): void {
  const st = usePdfAnnotationStore.getState();
  const doc = st.buckets[tabId]?.doc;
  if (!doc) return;
  for (const a of doc.annotations) {
    if (a.type !== 'note') continue;
    const draft = noteDrafts.get(a.id);
    if (draft === undefined) continue;
    noteDrafts.delete(a.id);
    noteAutoFocus.delete(a.id);
    const text = (a as Note).text;
    if (draft.trim() === '') {
      if (text !== '') st.remove(tabId, a.id);
      else st.discardNote(tabId, a.id);
    } else if (draft !== text) {
      st.commitNoteText(tabId, a.id, draft);
    }
  }
}
