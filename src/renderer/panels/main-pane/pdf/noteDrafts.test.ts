import { beforeEach, describe, expect, it } from 'vitest';
import { noteDrafts, noteAutoFocus, flushDrafts } from './noteDrafts';
import { usePdfAnnotationStore } from './pdfAnnotationStore';
import type { Note, PdfAnnotationsFile } from '../../../../shared/pdfSidecar';

function note(id: string, text: string): Note {
  return {
    id, type: 'note', page: 1, color: 'ink', size: 2,
    x: 10, y: 10, width: 100, text,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
}
function doc(...ns: Note[]): PdfAnnotationsFile {
  return { version: 1, pdf: 'paper.pdf', annotations: ns };
}

describe('flushDrafts', () => {
  beforeEach(() => {
    noteDrafts.clear();
    noteAutoFocus.clear();
    usePdfAnnotationStore.setState({ buckets: {} });
  });

  it('把草稿提交进 store', () => {
    usePdfAnnotationStore.getState().setLoaded('t1', doc(note('n1', '旧文本')));
    noteDrafts.set('n1', '新文本');

    flushDrafts('t1');

    const anns = usePdfAnnotationStore.getState().buckets.t1.doc!.annotations;
    expect((anns[0] as Note).text).toBe('新文本');
    expect(noteDrafts.has('n1')).toBe(false);
  });

  it('草稿与已存文本相同则不写，不污染撤销栈', () => {
    usePdfAnnotationStore.getState().setLoaded('t1', doc(note('n1', '一样')));
    noteDrafts.set('n1', '一样');

    flushDrafts('t1');

    expect(usePdfAnnotationStore.getState().buckets.t1.undo).toHaveLength(0);
  });

  it('只碰该 tab 的 note，别的 tab 的草稿留着', () => {
    usePdfAnnotationStore.getState().setLoaded('t1', doc(note('n1', '')));
    usePdfAnnotationStore.getState().setLoaded('t2', doc(note('n2', '')));
    noteDrafts.set('n1', 'A');
    noteDrafts.set('n2', 'B');

    flushDrafts('t1');

    expect(noteDrafts.has('n1')).toBe(false);
    expect(noteDrafts.get('n2')).toBe('B');
  });

  // 下面四条钉的是「flushDrafts 与 NoteBox 的 commit() 语义一致」：同一份草稿走失焦路径
  // 还是走关 tab 路径，结果必须一样。分叉的后果是边车里留下 text: '' 的隐形笔记（前三条），
  // 或者一条本该「交代过」的 note id 永远留在 noteAutoFocus 里、下次重挂时莫名抢焦点（第四条）。
  it('清空一条已提交过的笔记 = 删除（可撤销）', () => {
    usePdfAnnotationStore.getState().setLoaded('t1', doc(note('n1', '已经写过的内容')));
    noteDrafts.set('n1', '');

    flushDrafts('t1');

    const b = usePdfAnnotationStore.getState().buckets.t1;
    expect(b.doc!.annotations).toHaveLength(0);
    expect(b.undo).toHaveLength(1);   // 压了快照，撤销回得来
  });

  it('清空一条从未提交过的笔记 = 放弃（不入撤销栈）', () => {
    usePdfAnnotationStore.getState().setLoaded('t1', doc(note('n1', '')));
    noteDrafts.set('n1', '刚打了几个字又全删了');
    noteDrafts.set('n1', '');

    flushDrafts('t1');

    const b = usePdfAnnotationStore.getState().buckets.t1;
    expect(b.doc!.annotations).toHaveLength(0);
    expect(b.undo).toHaveLength(0);
  });

  it('只剩空白字符的草稿也算空（与 commit 的 trim 判据一致）', () => {
    usePdfAnnotationStore.getState().setLoaded('t1', doc(note('n1', '已经写过的内容')));
    noteDrafts.set('n1', '   \n  ');

    flushDrafts('t1');

    expect(usePdfAnnotationStore.getState().buckets.t1.doc!.annotations).toHaveLength(0);
  });

  it('冲掉草稿的同时也清 noteAutoFocus，不留着下次重挂自动抢焦点', () => {
    usePdfAnnotationStore.getState().setLoaded('t1', doc(note('n1', '')));
    noteDrafts.set('n1', '刚落下就打了几个字');
    noteAutoFocus.add('n1');

    flushDrafts('t1');

    expect(noteAutoFocus.has('n1')).toBe(false);
  });

  it('tab 不存在时什么都不做，不抛', () => {
    noteDrafts.set('n1', 'A');
    expect(() => flushDrafts('没有这个 tab')).not.toThrow();
    expect(noteDrafts.get('n1')).toBe('A');
  });
});
