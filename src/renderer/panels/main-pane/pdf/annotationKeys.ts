import { usePdfAnnotationStore } from './pdfAnnotationStore';

type KeyLike = {
  key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean;
  // 测试里传的是精简的 target 桩，不是真的 EventTarget；用 unknown 收，内部再窄化。
  target: unknown;
  preventDefault(): void;
};

/** spec §7.6 的快捷键表。返回 true 表示已处理（调用方应 preventDefault）。 */
export function handleAnnotationKey(e: KeyLike, tabId: string): boolean {
  const st = usePdfAnnotationStore.getState();
  const b = st.buckets[tabId];
  if (!b?.doc || b.loadError) return false;
  const target = e.target as { tagName?: string; blur?: () => void } | null;
  const inText = target?.tagName === 'TEXTAREA';
  if (e.key === 'Escape') {
    if (inText) target?.blur?.();
    st.setTool(tabId, 'select');
    st.select(tabId, null);
    return true;
  }
  if (inText) return false;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && (e.key === 'z' || e.key === 'Z')) {
    if (e.shiftKey) st.redo(tabId); else st.undo(tabId);
    return true;
  }
  if (mod) return false;
  switch (e.key) {
    case 'v': case 'V': st.setTool(tabId, 'select'); return true;
    case 'h': case 'H': st.setTool(tabId, 'highlight'); return true;
    case 't': case 'T': st.setTool(tabId, 'note'); return true;
    case 'Delete': case 'Backspace':
      if (!b.selectedId) return false;
      st.remove(tabId, b.selectedId);
      return true;
    default: return false;
  }
}
