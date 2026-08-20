import { useEffect, useState } from 'react';
import { useUiStore, type FileTab } from '../../../stores/uiStore';
import { buildHostThemeCss, injectHostTheme, readHostVar } from './reportTheme';

export function HtmlFileTab({ tab }: { tab: FileTab }) {
  const setFileTabStatus = useUiStore((s) => s.setFileTabStatus);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // ⚠️ 这里**故意**没有 PdfFileTab 那样的 `if (tab.status !== 'loading') return;` 守卫：
    // 自动重载正是靠 reloadNonce 变化时让这个 effect 在 status 已经是 'ready' 的情况下
    // 重跑一次。加上守卫会让文件变更后什么都不发生，而且不报错 —— 别为了「对齐
    // PdfFileTab」把它加回来（PdfFileTab 不消费 file.changed，那条守卫对它无害）。
    // 用 readBytes 而不是 readText：后者 2MB 上限，而报告正文不设长度上限，
    // 内联 SVG 很吃字节，顶上去只是时间问题。readBytes 是 100MB。
    window.kydog.invoke('file.readBytes', { path: tab.path })
      .then(({ bytes }) => {
        if (cancelled) return;
        setHtml(new TextDecoder('utf-8').decode(bytes));
        setFileTabStatus(tab.id, { status: 'ready' });
      })
      .catch((err: Error) => {
        if (!cancelled) setFileTabStatus(tab.id, { status: 'error', errorMessage: err.message });
      });
    return () => { cancelled = true; };
  }, [tab.id, tab.path, tab.reloadNonce, setFileTabStatus]);

  const theme = useUiStore((s) => s.theme);
  const readingFontSize = useUiStore((s) => s.readingFontSize);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);

  // 注入放在普通 effect 里而不是 useMemo：主题切换时 data-theme 由
  // ThemeApplier 的 layout effect 写入，渲染期间读 getComputedStyle 会读到旧值。
  useEffect(() => {
    if (html === null) { setSrcDoc(null); return; }
    setSrcDoc(injectHostTheme(html, buildHostThemeCss(readHostVar)));
  }, [html, theme, readingFontSize]);

  if (tab.status === 'error') {
    return (
      <div className="font-mono" style={{ padding: '14px 18px', fontSize: 12, color: 'var(--color-accent)' }}>
        无法打开文件：{tab.errorMessage}
      </div>
    );
  }
  if (srcDoc === null) {
    return (
      <div className="font-mono" style={{ padding: '14px 18px', fontSize: 12, color: 'var(--color-ink-soft)' }}>
        加载中…
      </div>
    );
  }
  return (
    <iframe
      data-testid={`html-frame-${tab.id}`}
      title={tab.title}
      srcDoc={srcDoc}
      // 不给 allow-scripts —— 任何来路的 .html 里的 JS 都不执行，这是整套安全模型的地基。
      // 不给 allow-same-origin：实测过它并不能让 app 打包的 webfont 在 frame 里生效
      // （@font-face 只在宿主的 fonts.css 里，从未注入进报告的 <head>，iframe 自己的
      // document.fonts 永远是空集），报告在 app 内退到 --font-serif 等变量里的系统字体
      // 兜底（Songti SC / Georgia 等）。少给一个权限更好，细节见
      // docs/superpowers/specs/2026-08-20-learning-deck-design.md 的「已知边界」。
      // allow-popups 让报告里 target="_blank" 的 DOI 链接能弹出，交给 main.ts:58 的
      // setWindowOpenHandler 转到系统浏览器 —— 别顺手把它也收掉：报告里的 DOI 链接会
      // 全部变成点了没反应。e2e/46-html-tab.spec.ts「报告里的外链交给系统浏览器打开」守着这条链。
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      className="w-full h-full"
      style={{ border: 'none', background: 'var(--color-paper)' }}
    />
  );
}
