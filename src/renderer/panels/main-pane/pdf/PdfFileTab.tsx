import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { useUiStore, type FileTab } from '../../../stores/uiStore';
import { emptyAnnotations } from '../../../../shared/pdfSidecar';
import { usePdfAnnotationStore } from './pdfAnnotationStore';
import { PdfAnnotationLayer } from './PdfAnnotationLayer';
import { PdfToolbar } from './PdfToolbar';
import { textLines, type TextItemLike, type TextLine } from './textLines';
import { mostVisiblePage, type PageRect } from './pageReadout';

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

type Layer = { id: number; scale: number };

// 结构化地描述 react-pdf 交给 onLoadSuccess 的 page proxy 里我们用到的三样东西，避免引 react-pdf 的内部类型路径。
type PageProxyLike = {
  pageNumber: number;
  getViewport(opts: { scale: number }): { width: number; height: number; convertToViewportPoint(x: number, y: number): number[] };
  getTextContent(): Promise<{ items: unknown[] }>;
};

export function PdfFileTab({ tab }: { tab: FileTab }) {
  const setFileTabStatus = useUiStore((s) => s.setFileTabStatus);
  const [bytes, setBytes] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageSizes, setPageSizes] = useState<Record<number, { w: number; h: number }>>({});
  const [currentPage, setCurrentPage] = useState(1);
  const pageProxies = useRef<Record<number, PageProxyLike>>({});
  const linesCache = useRef<Record<number, Promise<TextLine[]>>>({});
  const readoutRaf = useRef<number | null>(null);

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
      const top = el.getBoundingClientRect().top;
      const rects: PageRect[] = Array.from(el.querySelectorAll<HTMLElement>('[data-pdf-layer="stable"] [data-pdf-page]'))
        .map((node) => {
          const r = node.getBoundingClientRect();
          return { page: Number(node.dataset.pdfPage), top: r.top - top, bottom: r.bottom - top };
        });
      setCurrentPage(mostVisiblePage(rects, 0, el.clientHeight));
    });
  }, []);
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
  const numPagesRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const commitTimer = useRef<number | null>(null);
  const promoteTimer = useRef<number | null>(null);
  const progress = useRef<{ id: number; done: number }>({ id: -1, done: 0 }); // 新层渲染进度
  const focal = useRef({ x: 0, y: 0 });       // 缩放锚点：鼠标相对滚动视口的位置
  // 每帧缩放前的快照，供缩放后按锚点回算滚动位置
  const zoomAnchor = useRef<{ prevScale: number; sl: number; st: number } | null>(null);

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

  // 新层某一页渲染结束（成功或失败都计入）；全部页就绪即顶替
  const onPageSettled = useCallback((layerId: number) => {
    const cur = layersRef.current;
    const incoming = cur.length > 1 ? cur[cur.length - 1] : null;
    if (!incoming || incoming.id !== layerId) return; // 只统计后台新层
    if (progress.current.id !== layerId) progress.current = { id: layerId, done: 0 };
    progress.current.done += 1;
    if (numPagesRef.current > 0 && progress.current.done >= numPagesRef.current) promote();
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
        const target = targetScale.current;
        if (Math.abs(target - stable.scale) < 0.001) {
          setLayers([stable]); // 已是该缩放，丢弃任何未完成的新层
          return;
        }
        layerSeq.current += 1;
        const incoming: Layer = { id: layerSeq.current, scale: target };
        progress.current = { id: incoming.id, done: 0 };
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

  useEffect(() => { updateReadout(); }, [visualScale, layers, numPages, updateReadout]);

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
    <div style={{ position: 'relative', height: '100%' }}>
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
            onLoadSuccess={(pdf) => { numPagesRef.current = pdf.numPages; setNumPages(pdf.numPages); }}
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
                    {Array.from({ length: numPages }, (_, i) => {
                      const n = i + 1;
                      const size = pageSizes[n];
                      return (
                        <div key={n} data-pdf-page={n} style={{ position: 'relative' }}>
                          <Page
                            pageNumber={n}
                            scale={layer.scale}
                            renderTextLayer={false}
                            renderAnnotationLayer={false}
                            className="shadow-md"
                            onLoadSuccess={(p) => {
                              pageProxies.current[n] = p;
                              const v = p.getViewport({ scale: 1 });
                              setPageSizes((s) => (s[n] ? s : { ...s, [n]: { w: v.width, h: v.height } }));
                            }}
                            onRenderSuccess={() => onPageSettled(layer.id)}
                            onRenderError={() => onPageSettled(layer.id)}
                          />
                          {idx === 0 && size && (
                            <PdfAnnotationLayer
                              tabId={tab.id} page={n} pageWidth={size.w} pageHeight={size.h}
                              layerScale={layer.scale} ensureLines={ensureLines}
                            />
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
      <PdfToolbar tabId={tab.id} pageLabel={`${currentPage} / ${numPages || 1}`} zoomPct={Math.round(visualScale * 100)} />
    </div>
  );
}
