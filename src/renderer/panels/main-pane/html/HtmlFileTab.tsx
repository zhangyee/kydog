import { useCallback, useEffect, useRef, useState } from 'react';
import { useUiStore, type FileTab } from '../../../stores/uiStore';
import { buildHostThemeCss, dirnameOf, injectHostTheme, inlineLocalImages, readHostVar } from './reportTheme';

export function HtmlFileTab({ tab, isActive }: { tab: FileTab; isActive: boolean }) {
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

  // 两段独立 effect（Task 7b review Important 2）：图片内联要读盘 + base64，
  // 主题注入只是 DOM 操作。揉进同一个函数会导致切主题 / 调阅读字号这种跟图片
  // 内容毫无关系的操作，把报告里所有本地图片重新读一遍盘——见 reportTheme.ts
  // 顶部「跟 injectHostTheme 拆成两个独立阶段」的说明。
  const [inlinedHtml, setInlinedHtml] = useState<string | null>(null);
  useEffect(() => {
    if (html === null) { setInlinedHtml(null); return; }
    let cancelled = false;
    inlineLocalImages(html, dirnameOf(tab.path))
      .then((result) => { if (!cancelled) setInlinedHtml(result); })
      .catch((err: Error) => {
        // inlineLocalImagesInDoc 内部已经把单张图的失败兜成 rejected 分支，不会走到
        // 这里；这里只是防御性兜底 —— 万一真的抛了，也不能让报告卡在「加载中」，
        // 退化成显示未内联的原始 html（图片会以 alt 文字呈现，不会是坏图标）。
        console.error('inline local images failed', err);
        if (!cancelled) setInlinedHtml(html);
      });
    return () => { cancelled = true; };
  }, [html, tab.path]);

  const [srcDoc, setSrcDoc] = useState<string | null>(null);

  // 注入放在普通 effect 里而不是 useMemo：主题切换时 data-theme 由
  // ThemeApplier 的 layout effect 写入，渲染期间读 getComputedStyle 会读到旧值。
  // injectHostTheme 现在是同步函数（本地图片内联已经拆到上面那个 effect 里、
  // inlinedHtml 落地时已经是内联完的字符串），不需要 cancelled 守卫——函数体内
  // 没有 await 边界，不存在"旧调用的结果比新调用晚落地"的竞态窗口。
  useEffect(() => {
    if (inlinedHtml === null) { setSrcDoc(null); return; }
    // theme 现在有两个去处：值（buildHostThemeCss 拼出来的 :root 块）和**身份**
    // （injectHostTheme 写在根元素上的 data-kydog-theme）。后者是让报告不必靠
    // 量亮度猜「哪一档是浅色」的那条信号，见 reportTheme.ts 的 REPORT_THEME_ATTR。
    setSrcDoc(injectHostTheme(inlinedHtml, buildHostThemeCss(readHostVar), theme));
  }, [inlinedHtml, theme, readingFontSize]);

  // 打开报告后不必先点一下页面，方向键就能翻节：主动把焦点交给 iframe。
  //
  // **两步都要做。** `el.focus()` 只把**宿主文档**的 activeElement 指到 iframe 元素上；报告
  // 里的 keydown 监听挂在 iframe 自己的 document 上，要收到键，还得让 iframe 内部那个 window
  // 拿到焦点，也就是 `contentWindow.focus()`。以前只有第一步，于是「打开报告直接按方向键」
  // 在成品里根本不成立——必须先点一下页面（Yee 2026-09-07 手测确认）。
  // sandbox 没给 allow-same-origin，iframe 是 opaque origin；但 `focus()` 是跨源也允许调的
  // 那几个方法之一（同 blur / close / postMessage），所以这一步不需要放宽 sandbox。
  //
  // 这个 bug 以前被测试盖住了：46 那条用例在开发模式下跑，分离的 DevTools 窗口会让主窗口
  // blur 一次，Playwright 随后那次 CDP 按键把焦点重新走了一遍链路、顺带补上了第二步，于是
  // 用例一直是绿的。7a7ad9d 在 e2e 下关掉 DevTools 之后它才露出来（三平台 CI 同时红）。
  //
  // 依赖里必须有 isActive：tab 是保持挂载、用 display 切换可见的（MainPane.tsx），
  // 只依赖 srcDoc 的话，切走再切回来 srcDoc 没变，effect 不重跑，而焦点在
  // display:none 期间已经丢了 —— 那时候方向键就退化回「要先点一下」。
  // onLoad 那一路是给「srcDoc 刚设上、文档还没解析完」兜底：effect 跑在 React commit 之后、
  // iframe 文档就绪之前，那一刻聚焦的是还没被 srcDoc 顶替掉的初始文档。
  // e2e/46-html-tab.spec.ts 的「方向键在节间跳转」守首次打开这一路；切走再切回时两次 focus 都调到，
  // 由 HtmlFileTab.test.tsx 守。
  const frameRef = useRef<HTMLIFrameElement>(null);
  const focusFrame = useCallback(() => {
    const el = frameRef.current;
    if (!el) return;
    el.focus();
    el.contentWindow?.focus();
  }, []);
  useEffect(() => {
    if (isActive && srcDoc !== null) focusFrame();
  }, [srcDoc, isActive, focusFrame]);

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
      ref={frameRef}
      onLoad={() => { if (isActive) focusFrame(); }}
      data-testid={`html-frame-${tab.id}`}
      title={tab.title}
      srcDoc={srcDoc}
      // allow-scripts：报告需要跑 JS（方向键翻节、入场动效、进度条）。
      // 风险由注入的 CSP 兜住 —— connect-src 'none' 让脚本发不出 fetch / XHR / WebSocket，
      // form-action 'none' 让它提交不了表单，外部子资源全锁在 data:。
      // 唯一没被封住的出口是 window.open：CSP 管不到弹窗，而下面的 allow-popups 加上
      // main.ts 的 setWindowOpenHandler 会把 http(s) URL 交给系统浏览器，URL 里带什么就
      // 带什么。详见 reportTheme.ts 里 REPORT_CSP 的注释与 spec 的「已知边界」。
      // 仍不给 allow-same-origin：没有它，脚本读不到宿主的任何东西。也因此救不了 webfont
      // （@font-face 只在宿主的 fonts.css 里，从未注入进报告的 <head>，iframe 自己的
      // document.fonts 永远是空集），报告在 app 内退到 --font-serif 等变量里的系统字体
      // 兜底（Songti SC / Georgia 等）。细节见
      // docs/superpowers/specs/2026-08-20-learning-deck-v2-design.md 的「已知边界」。
      // allow-popups 让报告里 target="_blank" 的 DOI 链接能弹出，交给 main.ts:58 的
      // setWindowOpenHandler 转到系统浏览器 —— 别顺手把它也收掉：报告里的 DOI 链接会
      // 全部变成点了没反应。e2e/46-html-tab.spec.ts「报告里的外链交给系统浏览器打开」守着这条链。
      sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
      className="w-full h-full"
      style={{ border: 'none', background: 'var(--color-paper)' }}
    />
  );
}
