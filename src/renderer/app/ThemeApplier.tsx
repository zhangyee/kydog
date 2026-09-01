import { useLayoutEffect } from 'react';
import { useUiStore } from '../stores/uiStore';
import { overlayColors } from './overlayColors';
import { cssColorToHex, readCssToken } from './domColor';

export function ThemeApplier() {
  const theme = useUiStore((s) => s.theme);
  // useLayoutEffect 而非 useEffect：data-theme 必须在任何普通 effect 读
  // getComputedStyle 之前就落到 DOM 上（HtmlFileTab 要靠它转发主题变量）。
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    // Windows 右上角那三个窗口按钮是原生叠加层，不吃页面 CSS，主题换了得显式推给主进程，
    // 否则深色主题下会留一块浅色补丁。必须排在 setAttribute 之后 —— 读的得是新主题
    // 落到 DOM 之后的计算值。
    if (window.kydog?.platform !== 'win32') return;
    const colors = overlayColors(readCssToken, cssColorToHex);
    if (colors) void window.kydog.invoke('window.setTitleBarOverlay', colors);
  }, [theme]);
  return null;
}
