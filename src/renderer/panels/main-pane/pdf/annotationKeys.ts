import { usePdfAnnotationStore } from './pdfAnnotationStore';
import { canPressTranslate, usePdfTranslationStore } from './pdfTranslationStore';

type KeyLike = {
  key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean;
  // 测试里传的是精简的 target 桩，不是真的 EventTarget；用 unknown 收，内部再窄化。
  target: unknown;
  preventDefault(): void;
};

/** spec §7.6 的快捷键表。返回 true 表示已处理（调用方应 preventDefault）。
 *  `onToggleDual` 由 PdfFileTab 传入：进对照要按需 fit-width（读滚动容器宽度、可能改缩放），
 *  那部分 DOM 相关的逻辑留在组件里，这个纯函数只管「是不是这个快捷键、该不该放行」。 */
export function handleAnnotationKey(e: KeyLike, tabId: string, onToggleDual?: () => void): boolean {
  const target = e.target as { tagName?: string; blur?: () => void } | null;
  const inText = target?.tagName === 'TEXTAREA';

  // L：进 / 出双栏对照（PDF 双栏 spec §12）。它是**视图模式不是标注工具** —— 不走 setTool，
  // 也不受标注边车加载状态的限制（标注边车坏了照样该能读译文），所以这一条排在下面那道
  // 「标注没加载就什么都不处理」的闸**前面**。
  // 能不能放行由 canPressTranslate 判——与 PdfToolbar 的状态渲染共用同一份纯函数（见
  // pdfTranslationStore.ts 顶部注释），不在这里另写一遍「没有译文 / 边车有误 / 摘要对不上」
  // 的条件，避免两处判据走岔。禁用态按「没处理」返回 false，不 preventDefault，也不调用回调。
  if (!inText && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === 'l' || e.key === 'L')) {
    if (!canPressTranslate(usePdfTranslationStore.getState().buckets[tabId])) return false;
    onToggleDual?.();
    return true;
  }

  const st = usePdfAnnotationStore.getState();
  const b = st.buckets[tabId];
  if (!b?.doc || b.loadError) return false;
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
