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
 * 把该 tab 名下所有 note 的草稿提交进 store。只在关 tab / 卸载前调。
 *
 * 三个分支与 NoteBox 的 `commit()`（失焦路径）逐条对齐——同一份草稿走哪条路出去，结果必须一样：
 * 清空一条已提交过的笔记 = 删除（可撤销）、清空一条从未提交过的 = 放弃（不入撤销栈）、其余是改文本。
 * 只保留最后一条的话，用户清空一条已有笔记后**不失焦**地关 tab（Cmd+W / beforeunload 路径），
 * 边车里会留下一条 `text: ''` 的隐形笔记，而不是把它删掉。
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
    const text = (a as Note).text;
    if (draft.trim() === '') {
      if (text !== '') st.remove(tabId, a.id);
      else st.discardNote(tabId, a.id);
    } else if (draft !== text) {
      st.commitNoteText(tabId, a.id, draft);
    }
  }
}
