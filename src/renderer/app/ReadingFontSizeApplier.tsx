import { useLayoutEffect } from 'react';
import { useUiStore } from '../stores/uiStore';

export function ReadingFontSizeApplier() {
  const size = useUiStore((s) => s.readingFontSize);
  // useLayoutEffect 而非 useEffect：data-reading-size 必须在任何普通 effect 读
  // getComputedStyle 之前就落到 DOM 上（HtmlFileTab 要靠它转发字号变量）。
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-reading-size', size);
  }, [size]);
  return null;
}
