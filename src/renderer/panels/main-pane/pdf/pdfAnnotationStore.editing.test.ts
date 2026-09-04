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
    // addHighlight 走 edit()，确实会压一条快照——用它验证 undo 栈本身在正常工作，
    // 不然「长度不变」这个断言可能只是因为 undo 从头到尾就没被任何东西压过。
    st.addHighlight('t1', {
      id: 'h1', type: 'highlight', page: 1, color: 'amber', width: 2,
      segments: [{ kind: 'path', points: [[0, 0], [1, 1]] }],
      createdAt: new Date().toISOString(),
    });
    const before = usePdfAnnotationStore.getState().buckets.t1.undo.length;
    expect(before).toBeGreaterThan(0);
    st.setEditingPage('t1', 7);
    expect(usePdfAnnotationStore.getState().buckets.t1.undo).toHaveLength(before);
  });
});
