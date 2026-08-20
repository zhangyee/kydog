import { useLayoutEffect } from 'react';
import { useUiStore } from '../stores/uiStore';

export function ThemeApplier() {
  const theme = useUiStore((s) => s.theme);
  // useLayoutEffect 而非 useEffect：data-theme 必须在任何普通 effect 读
  // getComputedStyle 之前就落到 DOM 上（HtmlFileTab 要靠它转发主题变量）。
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);
  return null;
}
