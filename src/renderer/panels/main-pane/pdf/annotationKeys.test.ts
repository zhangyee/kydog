import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleAnnotationKey } from './annotationKeys';
import { usePdfAnnotationStore } from './pdfAnnotationStore';
import { usePdfTranslationStore } from './pdfTranslationStore';
import type { Highlight, PdfAnnotationsFile } from '../../../../shared/pdfSidecar';
import type { TranslatedDoc } from '../../../../shared/zhSidecar';

const T = '/p/paper.pdf';
const EMPTY: PdfAnnotationsFile = { version: 1, pdf: 'paper.pdf', annotations: [] };
const H: Highlight = { id: 'h1', type: 'highlight', page: 1, color: 'amber', width: 2,
  segments: [{ kind: 'path', points: [[0, 0], [9, 9]] }], createdAt: 'now' };
const st = () => usePdfAnnotationStore.getState();
const key = (k: string, extra: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; target: unknown }> = {}) =>
  ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, target: null, preventDefault() {}, ...extra });

const ZH: TranslatedDoc = {
  version: 1, pdf: 'paper.pdf', lang: { in: 'en', out: 'zh' },
  blocks: [{ id: 'b1', page: 1, x: 0, y: 0, width: 10, height: 10, fontSize: 10, kind: 'text', source: 'a', target: '甲' }],
};
const tst = () => usePdfTranslationStore.getState();

describe('handleAnnotationKey', () => {
  beforeEach(() => {
    usePdfAnnotationStore.setState({ buckets: {} });
    usePdfTranslationStore.setState({ buckets: {} });
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

  it('L 进出双栏对照，且不动标注工具（它是视图模式不是工具）', () => {
    tst().setLoaded(T, ZH, 'ok', 0);
    st().setTool(T, 'highlight');
    expect(handleAnnotationKey(key('l'), T)).toBe(true);
    expect(tst().buckets[T].dual).toBe(true);
    expect(st().buckets[T].tool).toBe('highlight');
    expect(handleAnnotationKey(key('L'), T)).toBe(true);
    expect(tst().buckets[T].dual).toBe(false);
  });

  it('没译文 / 摘要对不上 / ⌘L / 焦点在 textarea 里：L 都不处理', () => {
    expect(handleAnnotationKey(key('l'), T)).toBe(false);      // 边车不存在
    tst().setLoaded(T, ZH, 'mismatch', 0);
    expect(handleAnnotationKey(key('l'), T)).toBe(false);
    tst().setLoaded(T, ZH, 'ok', 0);
    expect(handleAnnotationKey(key('l', { metaKey: true }), T)).toBe(false);
    expect(handleAnnotationKey(key('l', { target: { tagName: 'TEXTAREA' } }), T)).toBe(false);
    expect(tst().buckets[T].dual).toBe(false);
  });

  it('标注边车坏了照样能按 L —— 译文视图不该受标注加载状态牵连', () => {
    st().setLoadError(T, '坏了');
    tst().setLoaded(T, ZH, 'ok', 0);
    expect(handleAnnotationKey(key('l'), T)).toBe(true);
    expect(tst().buckets[T].dual).toBe(true);
  });
});
