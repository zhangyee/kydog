import { beforeEach, describe, expect, it } from 'vitest';
import { usePdfAnnotationStore } from './pdfAnnotationStore';

describe('editingPage', () => {
  beforeEach(() => { usePdfAnnotationStore.setState({ buckets: {} }); });

  it('默认为 null', () => {
    usePdfAnnotationStore.getState().setLoaded('t1', { version: 1, pdf: 'p.pdf', annotations: [] });
    expect(usePdfAnnotationStore.getState().buckets.t1.editingPage).toBeNull();
  });

  it('设了能读回来，清空回 null', () => {
    const st = usePdfAnnotationStore.getState();
    st.setLoaded('t1', { version: 1, pdf: 'p.pdf', annotations: [] });
    st.setEditingPage('t1', 7);
    expect(usePdfAnnotationStore.getState().buckets.t1.editingPage).toBe(7);
    st.setEditingPage('t1', null);
    expect(usePdfAnnotationStore.getState().buckets.t1.editingPage).toBeNull();
  });

  it('不压撤销栈 —— 它是视图状态不是内容', () => {
    const st = usePdfAnnotationStore.getState();
    st.setLoaded('t1', { version: 1, pdf: 'p.pdf', annotations: [] });
    st.setEditingPage('t1', 7);
    expect(usePdfAnnotationStore.getState().buckets.t1.undo).toHaveLength(0);
  });
});
