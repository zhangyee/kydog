import { describe, it, expect, beforeEach } from 'vitest';
import { usePdfAnnotationStore } from './pdfAnnotationStore';
import type { Highlight, Note, PdfAnnotationsFile } from '../../../../shared/pdfSidecar';

const T = '/p/paper.pdf';
const EMPTY: PdfAnnotationsFile = { version: 1, pdf: 'paper.pdf', annotations: [] };
const H = (id: string): Highlight => ({ id, type: 'highlight', page: 1, color: 'amber', width: 2,
  segments: [{ kind: 'line', y: 53, x1: 40, x2: 200, text: 't' }], createdAt: 'now' });
const N = (id: string, text = ''): Note => ({ id, type: 'note', page: 1, color: 'ink', size: 2,
  x: 10, y: 20, width: 120, text, createdAt: 'now', updatedAt: 'now' });
const st = () => usePdfAnnotationStore.getState();
const b = () => st().buckets[T];

describe('pdfAnnotationStore', () => {
  beforeEach(() => {
    usePdfAnnotationStore.setState({ buckets: {} });
    st().setLoaded(T, EMPTY);
  });

  it('addHighlight 压一条快照、清空 redo', () => {
    st().addHighlight(T, H('h1'));
    expect(b().doc?.annotations).toHaveLength(1);
    expect(b().undo).toHaveLength(1);
    expect(b().undo[0]).toBe(EMPTY);
  });

  it('undo / redo 往返一致', () => {
    st().addHighlight(T, H('h1'));
    const after = b().doc;
    st().undo(T);
    expect(b().doc).toBe(EMPTY);
    expect(b().redo).toEqual([after]);
    st().redo(T);
    expect(b().doc).toBe(after);
    expect(b().redo).toEqual([]);
  });

  it('新动作清空 redo', () => {
    st().addHighlight(T, H('h1'));
    st().undo(T);
    st().addHighlight(T, H('h2'));
    expect(b().redo).toEqual([]);
  });

  it('撤销栈上限 100', () => {
    for (let i = 0; i < 120; i++) st().addHighlight(T, H(`h${i}`));
    expect(b().undo).toHaveLength(100);
  });

  it('setTool 与 undo 清选中', () => {
    st().addHighlight(T, H('h1'));
    st().select(T, 'h1');
    st().setTool(T, 'highlight');
    expect(b().selectedId).toBeNull();
    st().select(T, 'h1');
    st().undo(T);
    expect(b().selectedId).toBeNull();
  });

  it('addNote 与 discardNote 不入栈', () => {
    st().addNote(T, N('n1'));
    expect(b().doc?.annotations).toHaveLength(1);
    expect(b().undo).toHaveLength(0);
    st().discardNote(T, 'n1');
    expect(b().doc?.annotations).toHaveLength(0);
    expect(b().undo).toHaveLength(0);
  });

  it('首次 commitNoteText 的快照不含这条 note：撤销后不留空框', () => {
    st().addNote(T, N('n1'));
    st().commitNoteText(T, 'n1', '第一段');
    expect(b().undo).toHaveLength(1);
    expect(b().undo[0].annotations).toEqual([]);
    st().undo(T);
    expect(b().doc?.annotations).toEqual([]);
  });

  it('再次 commitNoteText 的快照含旧文本；文本没变不入栈', () => {
    st().addNote(T, N('n1'));
    st().commitNoteText(T, 'n1', 'a');
    st().commitNoteText(T, 'n1', 'a');
    expect(b().undo).toHaveLength(1);
    st().commitNoteText(T, 'n1', 'b');
    expect(b().undo).toHaveLength(2);
    expect((b().undo[1].annotations[0] as Note).text).toBe('a');
    expect((b().doc?.annotations[0] as Note).text).toBe('b');
  });

  it('remove 不存在的 id 不入栈；存在的删掉并清选中', () => {
    st().remove(T, 'nope');
    expect(b().undo).toHaveLength(0);
    st().addHighlight(T, H('h1'));
    st().select(T, 'h1');
    st().remove(T, 'h1');
    expect(b().doc?.annotations).toEqual([]);
    expect(b().selectedId).toBeNull();
    expect(b().undo).toHaveLength(2);
  });

  it('restyle 按类型改 color / width 或 size', () => {
    st().addHighlight(T, H('h1'));
    st().addNote(T, N('n1', 'x'));
    st().restyle(T, 'h1', { color: 'moss', level: 3 });
    st().restyle(T, 'n1', { level: 1 });
    expect(b().doc?.annotations[0]).toMatchObject({ color: 'moss', width: 3 });
    expect(b().doc?.annotations[1]).toMatchObject({ size: 1, color: 'ink' });
  });

  it('moveNote 改位置并入栈', () => {
    st().addNote(T, N('n1', 'x'));
    st().moveNote(T, 'n1', 99, 88);
    expect(b().doc?.annotations[0]).toMatchObject({ x: 99, y: 88 });
    expect(b().undo).toHaveLength(1);
  });

  it('loadError 的桶拒绝一切改动', () => {
    st().setLoadError(T, '坏了');
    st().addHighlight(T, H('h1'));
    st().addNote(T, N('n1'));
    expect(b().doc?.annotations).toEqual([]);
    expect(b().undo).toHaveLength(0);
  });

  it('setLoaded 后 setLoadError 时，discardNote / undo / redo / remove 拒改', () => {
    st().addHighlight(T, H('h1'));
    st().addNote(T, N('n1', 'x'));
    st().select(T, 'h1');
    const docBefore = b().doc;
    const undoBefore = b().undo;
    const redoBefore = b().redo;
    const selectedBefore = b().selectedId;
    st().setLoadError(T, '坏了');
    st().discardNote(T, 'n1');
    expect(b().doc).toEqual(docBefore);
    expect(b().undo).toEqual(undoBefore);
    expect(b().redo).toEqual(redoBefore);
    expect(b().selectedId).toBe(selectedBefore);
    st().undo(T);
    expect(b().doc).toEqual(docBefore);
    expect(b().undo).toEqual(undoBefore);
    expect(b().selectedId).toBe(selectedBefore);
    st().redo(T);
    expect(b().doc).toEqual(docBefore);
    expect(b().redo).toEqual(redoBefore);
    expect(b().selectedId).toBe(selectedBefore);
    st().remove(T, 'h1');
    expect(b().doc).toEqual(docBefore);
    expect(b().undo).toEqual(undoBefore);
    expect(b().selectedId).toBe(selectedBefore);
  });

  it('remove 不改非目标选中', () => {
    st().addHighlight(T, H('h1'));
    st().addHighlight(T, H('h2'));
    st().select(T, 'h1');
    st().remove(T, 'h2');
    expect(b().selectedId).toBe('h1');
  });

  it('setSaveError 不会凭空造桶；drop 删桶', () => {
    st().setSaveError('/p/other.pdf', 'x');
    expect(st().buckets['/p/other.pdf']).toBeUndefined();
    st().drop(T);
    expect(st().buckets[T]).toBeUndefined();
  });
});
