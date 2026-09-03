import { beforeEach, describe, expect, it } from 'vitest';
import { noteDrafts, flushDrafts } from './noteDrafts';
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

  it('tab 不存在时什么都不做，不抛', () => {
    noteDrafts.set('n1', 'A');
    expect(() => flushDrafts('没有这个 tab')).not.toThrow();
    expect(noteDrafts.get('n1')).toBe('A');
  });
});
