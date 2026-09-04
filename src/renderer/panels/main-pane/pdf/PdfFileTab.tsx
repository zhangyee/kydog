import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { useUiStore, type FileTab } from '../../../stores/uiStore';
import { emptyAnnotations } from '../../../../shared/pdfSidecar';
import { handleAnnotationKey } from './annotationKeys';
import { flushDrafts } from './noteDrafts';
import { usePdfAnnotationStore } from './pdfAnnotationStore';
import { PdfAnnotationLayer } from './PdfAnnotationLayer';
import { PdfAnnotationNotice } from './PdfAnnotationNotice';
import { PdfSelectionBar, type Anchor } from './PdfSelectionBar';
import { PdfToolbar } from './PdfToolbar';
import { pdfSaveScheduler } from './saveScheduler';
import { textLines, type TextItemLike, type TextLine } from './textLines';
import { mostVisiblePage, type PageRect } from './pageReadout';
import { unitLayout, type PageSize } from './pageLayout';
import { computeWindow, type WindowResult } from './pageWindow';

// pdf.js worker —— Vite 的 new URL 资产模式在 dev(http) 与 packaged(file://) 下均能解析
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const ZOOM_SENSITIVITY = 0.0075; // 每单位 deltaY 的缩放系数（越大捏合幅度越大）
const COMMIT_DELAY = 200;        // ms：手势停顿这么久后才在后台渲染清晰层
const PROMOTE_TIMEOUT = 4000;    // ms：清晰层渲染兜底超时，防个别页不回调而卡住
const PAGE_GAP = 16;             // 页间距基准（px，随缩放等比）
const PAGE_PAD = 24;             // 上下留白基准（px，随缩放等比）
// 单页预取失败（坏页字典等）时的占位尺寸——用最近一次成功页的尺寸，首页就失败则退到 A4。
// 目的是让 sizes 数组下标始终对齐页号（不能因为一页失败就少 push 一个，让后面的页整体前移），
// 且占位是个真实、非零的尺寸，故意避免下游（本文件的布局、以及 Task 5 的 unitLayout）
// 因 0 高度或 null 而出现异常布局或空指针。
export const FALLBACK_PAGE_SIZE: PageSize = { w: 595, h: 842 };

type Layer = { id: number; scale: number };

// 结构化地描述 react-pdf 交给 onLoadSuccess 的 page proxy 里我们用到的三样东西，避免引 react-pdf 的内部类型路径。
export type PageProxyLike = {
  pageNumber: number;
  getViewport(opts: { scale: number }): { width: number; height: number; convertToViewportPoint(x: number, y: number): number[] };
  getTextContent(): Promise<{ items: unknown[] }>;
};

/**
 * 预取全部页 scale 1 尺寸的核心循环，抽成不依赖 React/DOM/pdf.js 具体类型的纯函数，方便单测
 * 覆盖「单页失败」「取消」这两条容错路径——PdfFileTab 组件本体依赖 react-pdf/DOM/window.kydog，
 * 这个仓库的 vitest 是 `environment: 'node'`（无 jsdom），组件级渲染测试目前不可行，也不打算为
 * 这一条容错逻辑新增 jsdom / @testing-library 依赖（CLAUDE.md：加依赖先跟用户 review）。
 *
 * 单页失败被隔离（try/catch）：失败页不中断循环，占位后继续，故障粒度停在页级、不退化到文档级。
 * 占位统一用 `lastKnownSize`（最近一次成功页的尺寸，一页都没成功过则是 FALLBACK_PAGE_SIZE），
 * 保证下标依旧对齐页号——不能因为一页失败就不 push，否则后面的页在返回数组里全部前移一位。
 *
 * `isCancelled()` 在每次 await 之后都重新检查（成功分支、失败分支各一次），一旦为真立即返回
 * null：调用方据此判断这一趟作废，不该把已收集到的部分结果落地（那些结果属于已经切走的旧文件）。
 *
 * 页级副作用（写 proxy、失败留痕）通过回调交给调用方，好让「proxy 逐页可用、sizes 整趟完成后
 * 才提交」这一约定（Yee 2026-09-04 拍板）留在组件里，这个函数只管数组本身对不对。
 */
export async function prefetchPageSizes(
  numPages: number,
  getPage: (n: number) => Promise<PageProxyLike>,
  isCancelled: () => boolean,
  onPageReady: (n: number, page: PageProxyLike) => void,
  onPageFailed: (n: number, err: unknown) => void,
): Promise<PageSize[] | null> {
  const out: PageSize[] = [];
  let lastKnownSize = FALLBACK_PAGE_SIZE;
  for (let n = 1; n <= numPages; n++) {
    try {
      const p = await getPage(n);
      if (isCancelled()) return null;
      onPageReady(n, p);
      const v = p.getViewport({ scale: 1 });
      lastKnownSize = { w: v.width, h: v.height };
      out.push(lastKnownSize);
    } catch (err) {
      if (isCancelled()) return null;
      onPageFailed(n, err);
      out.push(lastKnownSize); // 占位保对齐，见函数注释
    }
  }
  return out;
}

export function PdfFileTab({ tab }: { tab: FileTab }) {
  const setFileTabStatus = useUiStore((s) => s.setFileTabStatus);
  const [bytes, setBytes] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [sizes, setSizes] = useState<PageSize[] | null>(null); // null = 还没预取完；sizes[n-1] 对应第 n 页
  const [currentPage, setCurrentPage] = useState(1);
  // 虚拟化窗口的输入：视口在**内容坐标**（scale 1 单位）里的位置，以及视口高度（CSS px）。
  //
  // 为什么记 scrollTop / visualScale 而不是 scrollTop 本身：缩放是按鼠标锚点回算滚动位置的
  // （见下方 useLayoutEffect），所以捏合时 scrollTop 每帧都被改写，改写量正比于滚动的绝对
  // 位置 —— 长文档翻到第 100 页时，一帧的差值就有好几页。而喂窗口的这个值必然落后一帧
  // （scroll 事件按 rAF 节流回来），于是手势期间窗口一直算在别的页上，把正看着的这页卸掉。
  // 实测过：25 帧的捏合里有 24 帧可见页身上没有 canvas，整个手势屏幕是空白的。
  //
  // 换成内容坐标就没有这个问题：锚点缩放的定义就是「锚点下的内容点不动」，所以内容坐标每帧
  // 只挪 focal·(1 − 1/f)/scale，几个 pt 而已，与滚动的绝对位置无关。落后一帧也无所谓。
  // 读的时候必须拿 el.scrollTop 配 visualScaleRef（DOM 当前反映的那个缩放），不能配将要
  // 提交的新缩放——两者在同一次 commit 里一起变，读到的永远是自洽的一对。
  const [contentTop, setContentTop] = useState(0);
  const [clientHeight, setClientHeight] = useState(0);
  const pageProxies = useRef<Record<number, PageProxyLike>>({});
  const linesCache = useRef<Record<number, Promise<TextLine[]>>>({});
  const readoutRaf = useRef<number | null>(null);
  // 换文件时把这代自增，让上一趟在途的页尺寸预取（见下方 Document onLoadSuccess）作废——
  // 不能在旧数据可能落地的那一刻才判断，得在“这是第几代文件”上打标。
  const prefetchToken = useRef(0);

  // 打开即并行加载标注；边车不存在 → 空文档（spec §6.4）
  useEffect(() => {
    let cancelled = false;
    window.kydog.invoke('pdf.annotations.load', { pdfPath: tab.path })
      .then(({ doc }) => {
        if (!cancelled) usePdfAnnotationStore.getState().setLoaded(tab.id, doc ?? emptyAnnotations(tab.path));
      })
      .catch((err: Error) => {
        if (!cancelled) usePdfAnnotationStore.getState().setLoadError(tab.id, err.message);
      });
    return () => { cancelled = true; };
  }, [tab.id, tab.path]);

  // 关 tab：先把草稿提交进 store、再把未落盘的改动冲掉，最后释放桶（spec §8.1）
  useEffect(() => {
    const tabId = tab.id;
    const onBeforeUnload = () => { flushDrafts(tabId); void pdfSaveScheduler.flush(tabId); };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      flushDrafts(tabId);                 // 草稿只在模块级 Map 里，不冲进 store 就随卸载一起没了
      void pdfSaveScheduler.flush(tabId);
      pdfSaveScheduler.forget(tabId);
      usePdfAnnotationStore.getState().drop(tabId);
    };
  }, [tab.id]);

  // 某页第一次要用文本几何时才取，取失败按无文本行处理（spec §6.3 / §8.3）
  const ensureLines = useCallback((n: number): Promise<TextLine[]> => {
    const cached = linesCache.current[n];
    if (cached) return cached;
    const proxy = pageProxies.current[n];
    if (!proxy) return Promise.resolve([]);
    const p = proxy.getTextContent()
      .then((c) => textLines(
        c.items.filter((it): it is TextItemLike => typeof (it as { str?: unknown }).str === 'string'),
        proxy.getViewport({ scale: 1 }),
      ))
      .catch(() => [] as TextLine[]);
    linesCache.current[n] = p;
    return p;
  }, []);

  // 页码读数：滚动时按 rAF 节流，取视口内可见高度最大的页（spec §7.1）
  const updateReadout = useCallback(() => {
    if (readoutRaf.current != null) return;
    readoutRaf.current = requestAnimationFrame(() => {
      readoutRaf.current = null;
      const el = scrollRef.current;
      if (!el) return;
      // 顺路把滚动几何记进 state：窗口要靠它算。挤在同一个 rAF 里读，不额外触发一次重排。
      setContentTop(el.scrollTop / visualScaleRef.current);
      setClientHeight(el.clientHeight);
      const top = el.getBoundingClientRect().top;
      const rects: PageRect[] = Array.from(el.querySelectorAll<HTMLElement>('[data-pdf-layer="stable"] [data-pdf-page]'))
        .map((node) => {
          const r = node.getBoundingClientRect();
          return { page: Number(node.dataset.pdfPage), top: r.top - top, bottom: r.bottom - top };
        });
      setCurrentPage(mostVisiblePage(rects, 0, el.clientHeight));
      // scrollTick 只是喂给浮条锚点 useLayoutEffect 的重算信号；没有选中项时浮条不存在，
      // 重算是白费一次全 tab 子树重渲染——只在有选中时才 bump（item 3）。
      if (usePdfAnnotationStore.getState().buckets[tab.id]?.selectedId) setScrollTick((t) => t + 1);
    });
  }, [tab.id]);
  useEffect(() => () => { if (readoutRaf.current != null) cancelAnimationFrame(readoutRaf.current); }, []);

  // 双缓冲消除缩放闪烁（react-pdf 每页只有一个 canvas，改 scale 会清空并隐藏 canvas）：
  // - layers[0]：已渲染完成、正在显示的「清晰层」
  // - layers[1]（若有）：按新缩放在后台（旧层下方）渲染的「新层」，全部页画好后整层顶替
  // - 手势进行中只改各层外层的 CSS zoom（visualScale），不触发 canvas 重渲染 → 不闪
  const [layers, setLayers] = useState<Layer[]>([{ id: 0, scale: 1 }]);
  const [visualScale, setVisualScale] = useState(1); // 当前显示缩放（连续）

  const scrollRef = useRef<HTMLDivElement>(null);
  const layerSeq = useRef(0);
  const targetScale = useRef(1);              // 连续累积的目标缩放
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const visualScaleRef = useRef(visualScale);
  visualScaleRef.current = visualScale;
  const rafRef = useRef<number | null>(null);
  const commitTimer = useRef<number | null>(null);
  const promoteTimer = useRef<number | null>(null);
  // 新层渲染进度：按页号存，不是计数——同一页 onRenderError 之后又 onRenderSuccess 不能重复计数
  const progress = useRef<{ id: number; done: Set<number> }>({ id: -1, done: new Set() });
  const focal = useRef({ x: 0, y: 0 });       // 缩放锚点：鼠标相对滚动视口的位置
  // 每帧缩放前的快照，供缩放后按锚点回算滚动位置
  const zoomAnchor = useRef<{ prevScale: number; sl: number; st: number } | null>(null);

  // 每页顶边偏移与内容总高，按预取到的页尺寸算——虚拟化之后窗口外的行没有内容可量，
  // 只能算（pageLayout.ts）。
  //
  // 已知误差：sizes 里可能混着占位尺寸。某页预取失败时 prefetchPageSizes 用上一页（首页失败
  // 则用 FALLBACK_PAGE_SIZE）顶上，占位与真实高度之差会让**该页之后所有页**的 tops 带一个
  // 恒定偏移，表现为滚过那一页之后页与视口错开一点、窗口偏了一格。失败页本来就拿不到真实
  // 尺寸，这里没法修；记在这里是免得下次把它当成布局 bug 从头查一遍。
  const layout = useMemo(() => (sizes ? unitLayout(sizes, PAGE_GAP, PAGE_PAD) : null), [sizes]);

  // Task 7 之前这里恒为 null（store 里有槽位、还没有写入方），窗口逻辑照常工作。
  const editingPage = usePdfAnnotationStore((s) => s.buckets[tab.id]?.editingPage ?? null);

  // 要挂载哪些页、以多细的位图挂——两件事一起定（pageWindow.ts）。
  const win = useMemo<WindowResult>(() => {
    if (!sizes || !layout) return { pages: new Set(), visible: new Set(), rasterScale: visualScale };
    return computeWindow({
      sizes, tops: layout.tops, scrollTop: contentTop * visualScale, clientHeight,
      visualScale, dpr: window.devicePixelRatio, columns: 1, editingPage,
    });
  }, [sizes, layout, contentTop, clientHeight, visualScale, editingPage]);
  // onWheel / onPageSettled 都挂在 effect 或回调里，闭包拿不到最新的 win，用 ref 镜像
  const winRef = useRef(win);
  winRef.current = win;

  // 加载 PDF 字节
  useEffect(() => {
    if (tab.status !== 'loading') return;
    let cancelled = false;
    window.kydog.invoke('file.readBytes', { path: tab.path })
      .then(({ bytes }) => {
        if (cancelled) return;
        setBytes(bytes);
        setFileTabStatus(tab.id, { status: 'ready' });
      })
      .catch((err: Error) => {
        if (!cancelled) setFileTabStatus(tab.id, { status: 'error', errorMessage: err.message });
      });
    return () => { cancelled = true; };
  }, [tab.id, tab.path, tab.status, setFileTabStatus]);

  // 字节 → Blob URL：避免 react-pdf 把 ArrayBuffer 转交 worker 后 detach
  // 导致的 StrictMode/重挂载报错；URL 在卸载时回收
  const fileUrl = useMemo(() => {
    if (!bytes) return null;
    return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  }, [bytes]);
  useEffect(() => () => {
    if (fileUrl) URL.revokeObjectURL(fileUrl);
  }, [fileUrl]);

  // 换文件：让上一代的页尺寸预取作废，并清掉它可能已经部分填过的缓存/state。
  // 这个 effect 在 commit 之后同步跑，严格早于新 Document 的异步加载完成（onLoadSuccess
  // 只会在其自身 effect 之后、经过至少一次 pdf.js 的异步工作才触发）——所以预取回调里
  // 在“调用那一刻”读到的 prefetchToken.current 必然已经是这次自增后的新代号。
  useEffect(() => {
    prefetchToken.current += 1;
    setSizes(null);
    pageProxies.current = {};
    linesCache.current = {};
  }, [fileUrl]);

  // 缩放后按鼠标锚点回算滚动位置，使鼠标下的内容点保持不动（同 macOS 预览）
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = zoomAnchor.current;
    if (!el || !a) return;
    const f = visualScale / a.prevScale;
    if (f === 1) return;
    el.scrollLeft = (a.sl + focal.current.x) * f - focal.current.x;
    el.scrollTop = (a.st + focal.current.y) * f - focal.current.y;
  }, [visualScale]);

  // 把后台新层提升为唯一的清晰层（旧层同时移除）
  const promote = useCallback(() => {
    if (promoteTimer.current != null) { clearTimeout(promoteTimer.current); promoteTimer.current = null; }
    setLayers((cur) => (cur.length > 1 ? [cur[cur.length - 1]] : cur));
  }, []);

  // 新层某一页渲染结束（成功或失败都计入）；**可见页**全部就绪即顶替。
  // 不能再按 numPages 判定：虚拟化之后窗口外的页压根不挂载，那个数永远凑不齐，每次缩放都要
  // 卡满 PROMOTE_TIMEOUT 才顶替。也不按整个窗口判定：窗口里还有预取页，它们画完与否用户看不见，
  // 等它们只会让顶替更晚。
  const onPageSettled = useCallback((layerId: number, page: number) => {
    const cur = layersRef.current;
    const incoming = cur.length > 1 ? cur[cur.length - 1] : null;
    if (!incoming || incoming.id !== layerId) return; // 只统计后台新层
    const need = winRef.current.visible;              // 读 ref：渲染期间用户可能已经滚走了
    if (!need.has(page)) return;
    if (progress.current.id !== layerId) progress.current = { id: layerId, done: new Set() };
    const done = progress.current.done;
    done.add(page);
    if (need.size > 0 && [...need].every((p) => done.has(p))) promote();
  }, [promote]);

  // 触摸板捏合缩放：Chromium 把捏合转成 ctrl+wheel
  useEffect(() => {
    if (tab.status !== 'ready') return;
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // 非捏合的滚轮 → 走默认滚动（连续翻页）
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      focal.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      targetScale.current = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, targetScale.current * (1 - e.deltaY * ZOOM_SENSITIVITY)),
      );
      // 手势中：每帧更新一次 CSS zoom，瞬时无闪
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          zoomAnchor.current = { prevScale: visualScaleRef.current, sl: el.scrollLeft, st: el.scrollTop };
          setVisualScale(targetScale.current);
        });
      }
      // 停顿 COMMIT_DELAY 后：在后台以新缩放渲染一层清晰层
      if (commitTimer.current != null) clearTimeout(commitTimer.current);
      commitTimer.current = window.setTimeout(() => {
        commitTimer.current = null;
        const stable = layersRef.current[0];
        // 用窗口算出来的栅格分辨率，不是视觉缩放：视觉超出预算上界的那部分由外层 CSS zoom
        // （下面的 visualScale / layer.scale）补，表现为「放到很大只是变糊」，而不是把位图撑爆。
        const target = winRef.current.rasterScale;
        if (Math.abs(target - stable.scale) < 0.001) {
          setLayers([stable]); // 已是该缩放，丢弃任何未完成的新层
          return;
        }
        layerSeq.current += 1;
        const incoming: Layer = { id: layerSeq.current, scale: target };
        progress.current = { id: incoming.id, done: new Set() };
        setLayers([stable, incoming]);
        if (promoteTimer.current != null) clearTimeout(promoteTimer.current);
        promoteTimer.current = window.setTimeout(promote, PROMOTE_TIMEOUT);
      }, COMMIT_DELAY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('scroll', updateReadout, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', updateReadout);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (commitTimer.current != null) clearTimeout(commitTimer.current);
      if (promoteTimer.current != null) clearTimeout(promoteTimer.current);
    };
  }, [tab.status, promote, updateReadout]);

  // 视口尺寸变了（拖窗、开合侧栏）窗口也要重算——这时没有滚动事件，updateReadout 不会跑
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setClientHeight(el.clientHeight);
      setContentTop(el.scrollTop / visualScaleRef.current);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab.status]);

  useEffect(() => { updateReadout(); }, [visualScale, layers, numPages, updateReadout]);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const [scrollTick, setScrollTick] = useState(0);
  const selectedId = usePdfAnnotationStore((s) => s.buckets[tab.id]?.selectedId ?? null);
  const doc = usePdfAnnotationStore((s) => s.buckets[tab.id]?.doc ?? null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  // 浮条锚点：选中项元素相对外层容器的框；滚动、缩放、doc 变化都重算
  useLayoutEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap || !selectedId) { setAnchor(null); return; }
    const el = wrap.querySelector<HTMLElement>(`[data-pdf-layer="stable"] [data-annotation-id="${selectedId}"]`);
    if (!el) { setAnchor(null); return; }
    const w = wrap.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    setAnchor({ left: r.left - w.left, top: r.top - w.top, bottom: r.bottom - w.top, width: r.width });
  }, [selectedId, doc, visualScale, layers, scrollTick]);

  if (tab.status === 'loading') {
    return (
      <div className="font-mono" style={{ padding: '14px 18px', fontSize: 12, color: 'var(--color-ink-soft)' }}>
        加载中…
      </div>
    );
  }
  if (tab.status === 'error') {
    return (
      <div className="font-mono" style={{ padding: '14px 18px', fontSize: 12, color: 'var(--color-accent)' }}>
        无法打开文件：{tab.errorMessage}
      </div>
    );
  }
  return (
    <div
      ref={wrapperRef}
      tabIndex={0}
      style={{ position: 'relative', height: '100%', outline: 'none' }}
      onKeyDown={(e) => { if (handleAnnotationKey(e, tab.id)) e.preventDefault(); }}
      onPointerDownCapture={(e) => {
        const t = e.target as Element;
        if (!t.closest('textarea, button')) wrapperRef.current?.focus();
      }}
    >
      <div
        ref={scrollRef}
        data-testid={`pdf-scroll-${tab.id}`}
        className="ky-scroll h-full overflow-auto"
        style={{ background: 'var(--color-paper-deep)' }}
      >
        {fileUrl && (
          <Document
            file={fileUrl}
            loading={null}
            error={null}
            onLoadSuccess={(pdf) => {
              setNumPages(pdf.numPages);
              // 预取全部页的 scale 1 尺寸：解析页字典，不栅格化。虚拟化要靠它给窗口外的行
              // 精确高度，顺带把 page proxy 填满——ensureLines 原先等 <Page onLoadSuccess>，
              // 虚拟化后窗口外的页那个回调永远不来。
              //
              // 取消机制：myToken 在“回调被调用的那一刻”读取 prefetchToken.current（不是在
              // render 时提前捕获）。上面换文件的 effect 保证了它对这次加载而言必然已经自增到
              // 位——effect 在 commit 之后同步跑，严格早于本次 onLoadSuccess 能触发的最早时机
              // （那至少要经过一轮 pdf.js 的异步加载）。所以 myToken 就是“这次加载所属的那一
              // 代”；此后若再换文件，effect 会再自增一次，循环体里下一次 await 之后的比较就会
              // 失配而提前返回，旧数据不会写进 pageProxies / linesCache / setSizes。
              const myToken = prefetchToken.current;
              void (async () => {
                // 逐页容错/取消的循环体在 prefetchPageSizes（本文件顶部）里，抽成纯函数是为了
                // 能在不拉起整个组件（jsdom 等）的前提下单测「单页失败」「换文件取消」这两条路径。
                // proxy 写入仍留在这里逐页发生（不是等整趟跑完再批量写）：ensureLines 依赖某页
                // 一成功就能立刻拿到 proxy，不用等同一文档的其余页也解析完。
                const out = await prefetchPageSizes(
                  pdf.numPages,
                  (n) => pdf.getPage(n) as unknown as Promise<PageProxyLike>,
                  () => prefetchToken.current !== myToken,
                  (n, p) => { pageProxies.current[n] = p; },
                  (n, err) => console.warn(`PDF 第 ${n} 页尺寸预取失败，占位后继续`, err),
                );
                if (out && prefetchToken.current === myToken) setSizes(out);
              })();
            }}
            onLoadError={(err) =>
              setFileTabStatus(tab.id, { status: 'error', errorMessage: err.message })
            }
          >
            {/* relative 容器：清晰层（idx 0）在流内定版面，后台新层（idx 1）绝对叠在其下方 */}
            <div style={{ position: 'relative' }}>
              {layers.map((layer, idx) => (
                <div
                  key={layer.id}
                  data-pdf-layer={idx === 0 ? 'stable' : 'incoming'}
                  style={idx === 0
                    ? { position: 'relative', zIndex: 1, zoom: visualScale / layer.scale }
                    : { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 0, zoom: visualScale / layer.scale }}
                >
                  {/* w-max + min-w-full：宽度贴合最宽的一页且不小于视口 —— 页比视口宽时
                      左右都能滚到、页比视口窄时仍居中。gap/padding 随 layer.scale 等比，
                      与 zoom 叠加后两层版面恒等，顶替时不跳。 */}
                  <div
                    className="flex flex-col items-center w-max min-w-full"
                    style={{
                      gap: `${PAGE_GAP * layer.scale}px`,
                      padding: `${PAGE_PAD * layer.scale}px 0`,
                    }}
                  >
                    {/* 页行始终在 DOM 且显式给出高宽（不再靠 <Page> 撑起来）：窗口外的空行也占住
                        正确的位置，scrollHeight 从第一帧起就是终值，滚动条不会边滚边变长。
                        只有窗口内的行才挂 <Page>（真正的 canvas 与栅格化开销）。 */}
                    {sizes && layout && sizes.map((size, k) => {
                      const n = k + 1;
                      const mounted = win.pages.has(n);
                      return (
                        <div
                          key={n}
                          data-pdf-page={n}
                          data-pdf-mounted={mounted ? '1' : undefined}
                          style={{ height: size.h * layer.scale, width: size.w * layer.scale, flexShrink: 0 }}
                        >
                          {mounted && (
                            <div style={{ position: 'relative' }}>
                              <Page
                                pageNumber={n}
                                scale={layer.scale}
                                renderTextLayer={false}
                                renderAnnotationLayer={false}
                                className="shadow-md"
                                onLoadSuccess={(p) => { pageProxies.current[n] = p; }}
                                onRenderSuccess={() => onPageSettled(layer.id, n)}
                                onRenderError={() => onPageSettled(layer.id, n)}
                              />
                              {idx === 0 && (
                                <PdfAnnotationLayer
                                  tabId={tab.id} page={n} pageWidth={size.w} pageHeight={size.h}
                                  layerScale={layer.scale} ensureLines={ensureLines}
                                />
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Document>
        )}
      </div>
      <PdfAnnotationNotice tabId={tab.id} pdfPath={tab.path} />
      <PdfToolbar tabId={tab.id} pageLabel={`${currentPage} / ${numPages || 1}`} zoomPct={Math.round(visualScale * 100)} />
      {anchor && <PdfSelectionBar tabId={tab.id} anchor={anchor} />}
    </div>
  );
}
