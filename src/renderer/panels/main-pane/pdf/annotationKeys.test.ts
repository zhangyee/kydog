import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleAnnotationKey } from './annotationKeys';
import { usePdfAnnotationStore } from './pdfAnnotationStore';
import type { Highlight, PdfAnnotationsFile } from '../../../../shared/pdfSidecar';

const T = '/p/paper.pdf';
const EMPTY: PdfAnnotationsFile = { version: 1, pdf: 'paper.pdf', annotations: [] };
const H: Highlight = { id: 'h1', type: 'highlight', page: 1, color: 'amber', width: 2,
  segments: [{ kind: 'path', points: [[0, 0], [9, 9]] }], createdAt: 'now' };
const st = () => usePdfAnnotationStore.getState();
const key = (k: string, extra: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; target: unknown }> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, target: null, preventDefault() {}, ...extra });

describe('handleAnnotationKey', () => {
  beforeEach(() => {
    usePdfAnnotationStore.setState({ buckets: {} });
    st().setLoaded(T, EMPTY);
  });

  it('V / H / T 切工具', () => {
    expect(handleAnnotationKey(key('h'), T)).toBe(true);
    expect(st().buckets[T].tool).toBe('highlight');
    handleAnnotationKey(key('T'), T);
    expect(st().buckets[T].tool).toBe('note');
    handleAnnotationKey(key('v'), T);
    expect(st().buckets[T].tool).toBe('select');
  });

  it('⌘Z 撤销、⇧⌘Z 重做；Ctrl 同样算', () => {
    st().addHighlight(T, H);
    expect(handleAnnotationKey(key('z', { metaKey: true }), T)).toBe(true);
    expect(st().buckets[T].doc?.annotations).toEqual([]);
    handleAnnotationKey(key('z', { ctrlKey: true, shiftKey: true }), T);
    expect(st().buckets[T].doc?.annotations).toHaveLength(1);
  });

  it('Delete / Backspace 删选中项；没选中不处理', () => {
    expect(handleAnnotationKey(key('Delete'), T)).toBe(false);
    st().addHighlight(T, H);
    st().select(T, 'h1');
    expect(handleAnnotationKey(key('Backspace'), T)).toBe(true);
    expect(st().buckets[T].doc?.annotations).toEqual([]);
  });

  it('焦点在 textarea 里：字母键不处理，Esc 先 blur 再回到选择并取消选中', () => {
    const blur = vi.fn();
    const ta = { tagName: 'TEXTAREA', blur };
    st().setTool(T, 'note');
    st().addHighlight(T, H);
    st().select(T, 'h1');
    expect(handleAnnotationKey(key('h', { target: ta }), T)).toBe(false);
    expect(handleAnnotationKey(key('Delete', { target: ta }), T)).toBe(false);
    expect(handleAnnotationKey(key('Escape', { target: ta }), T)).toBe(true);
    expect(blur).toHaveBeenCalled();
    expect(st().buckets[T]).toMatchObject({ tool: 'select', selectedId: null });
  });

  it('未加载或 loadError 时全部不处理', () => {
    st().setLoadError(T, '坏了');
    expect(handleAnnotationKey(key('h'), T)).toBe(false);
    expect(handleAnnotationKey(key('h'), '/p/other.pdf')).toBe(false);
  });
});
