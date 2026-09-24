// src/renderer/assets/mdPrintPage.ts
//
// md-print.html 的全部逻辑（spec docs/superpowers/specs/2026-09-22-md-export-pdf-design.md §3.3 / §3.4）。
// 跑在主进程 mdPdfExport.ts 开的不显示窗口里，由它 executeJavaScript 驱动，不属于 KyDog 的 UI；
// 那个窗口不挂 preload，没有 window.kydog。
import '../index.css';
import '../panels/main-pane/markdown/print.css';
import { editorViewCtx } from '@milkdown/kit/core';
import { createCrepe } from '../panels/main-pane/markdown/crepeSetup';
import { factsFromDoc, factsFromDom, isPrintReady, languagesToLoad } from '../panels/main-pane/markdown/printReadiness';

export type MdPrintPayload = {
  markdown: string;
  mdPath: string;
  title: string;
  readingFontSize: 'small' | 'medium' | 'large';
  pageNumbers: boolean;
};

/**
 * 「全部可见」的 IntersectionObserver。Crepe 的代码块只给进入视口 ±200px 的块挂 CodeMirror，
 * 其余停在纯文本占位（公式只剩 TeX 原文）—— 打印时视口外的块就这样被印出来（2026-09-22 探针实测）。
 * 这一页里所有东西都算可见，块就全挂上。只在这个页面装，不碰编辑器。
 * 必须在任何 Crepe 实例建出来之前装好：代码块的共享观察者是第一次建块时才 new 的。
 */
// IntersectionObserverCallback 是纯类型别名（lib.dom.d.ts），运行时不存在，ESLint 的
// no-undef（eslint.config.mjs 的 globals 只收运行时全局）认不出这个名字；就地写同构的
// 函数类型，绕开而不是去改全局 lint 配置。
type IntersectionCallback = (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void;

class AllVisibleObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];
  constructor(private readonly callback: IntersectionCallback) {}
  observe(target: Element): void {
    queueMicrotask(() => this.callback(
      [{ target, isIntersecting: true, intersectionRatio: 1 } as unknown as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    ));
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}
window.IntersectionObserver = AllVisibleObserver as unknown as typeof IntersectionObserver;

/** 条件成立才兑现；DOM 变化（挂块、挂语言、出 img）与图片 load / error 时复查。不设等待时长。 */
function waitUntil(root: HTMLElement, ready: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (!ready()) return;
      observer.disconnect();
      root.removeEventListener('load', check, true);
      root.removeEventListener('error', check, true);
      resolve();
    };
    const observer = new MutationObserver(check);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-language', 'src'] });
    // img 的 load / error 不冒泡，捕获阶段拿得到
    root.addEventListener('load', check, true);
    root.addEventListener('error', check, true);
    check();
  });
}

async function renderForPrint(p: MdPrintPayload): Promise<void> {
  if (p.pageNumbers) {
    const style = document.createElement('style');
    // macOS CI 的 Chromium 页边距盒把 sans-serif 整段漏印（静态文字也没了）；
    // 同一打印窗口里 serif 的静态文字、counter(page) 和破折号都已实测能印。
    style.textContent = '@page { @bottom-center { content: "— " counter(page) " —"; '
      + 'font: 8px serif; color: #8a8a8a; } }';
    document.head.append(style);
  }
  const html = document.documentElement;
  html.setAttribute('data-theme', 'vellum');
  html.setAttribute('data-reading-size', p.readingFontSize);
  document.title = p.title;
  const root = document.getElementById('md-print-root');
  if (!root) throw new Error('打印页缺少 #md-print-root');

  const crepe = createCrepe({ mode: 'print', root, markdown: p.markdown, mdPath: p.mdPath });
  await crepe.create();
  crepe.setReadonly(true);
  const doc = crepe.editor.action((ctx) => ctx.get(editorViewCtx).state.doc);
  // 预加载文档里用到的语言：与 Crepe 自己那次 load() 是同一个 LanguageDescription、同一个 promise，
  // 等它兑现后各块的语言随即挂上（data-language），下面的判据再确认一遍。
  await Promise.all(languagesToLoad(doc).map((d) => d.load()));
  await waitUntil(root, () => isPrintReady({ ...factsFromDoc(doc), ...factsFromDom(root) }));
  await document.fonts.ready;
}

declare global {
  interface Window {
    __mdPrint: typeof renderForPrint;
    __mdPrintReady: Promise<void>;
    __mdPrintResolve: () => void;
    __mdPrintReject: (err: unknown) => void;
  }
}

window.__mdPrint = renderForPrint;
window.__mdPrintResolve();
