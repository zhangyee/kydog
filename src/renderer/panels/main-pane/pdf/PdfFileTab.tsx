import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useThreadsStore } from '../../../stores/threadsStore';
import { useUiStore, type FileTab } from '../../../stores/uiStore';
import { confirm } from '../../../stores/confirmStore';
import { emptyAnnotations } from '../../../../shared/pdfSidecar';
import { filterByGeometry, type Block, type TranslatedDoc } from '../../../../shared/zhSidecar';
import { handleAnnotationKey } from './annotationKeys';
import { cellKey, createCanvasRegistry, type CanvasRegistry } from './canvasRegistry';
import { flushDrafts } from './noteDrafts';
import { OverlayScrollbar } from './PdfOverlayScrollbar';
import { PaneDivider } from './PaneDivider';
import { createScrollSync } from './scrollSync';
import { clampSplit, fitToNarrower, paneWidths } from './splitPane';
import { usePdfAnnotationStore } from './pdfAnnotationStore';
import { canPressTranslate, checkVersion, translateUiState, usePdfTranslationStore } from './pdfTranslationStore';
import { sha256Hex } from './sha256';
import { PdfAnnotationLayer } from './PdfAnnotationLayer';
import { PdfAnnotationNotice } from './PdfAnnotationNotice';
import { PdfSelectionBar, type Anchor } from './PdfSelectionBar';
import { PdfToolbar } from './PdfToolbar';
import type { RGB } from './pageBackground';
import { RightPage } from './RightPage';
import { pdfSaveScheduler } from './saveScheduler';
import { translateDoc } from './translateDoc';
import { TranslationBlocks } from './TranslationBlocks';
import { TranslationProgress } from './TranslationProgress';
import { textLines, type TextItemLike, type TextLine } from './textLines';
import { mostVisiblePage } from './pageReadout';
import { unitLayout, PAGE_GAP, PAGE_PAD, type PageSize } from './pageLayout';
import { computeWindow, sameWindow, type WindowResult } from './pageWindow';
import { createPageLifecycle, type Cleanable, type PageLifecycle } from './pageLifecycle';
import { ZOOM_SENSITIVITY } from './zoomSensitivity';

// pdf.js worker —— Vite 的 new URL 资产模式在 dev(http) 与 packaged(file://) 下均能解析
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const COMMIT_DELAY = 200;        // ms：手势停顿这么久后才在后台渲染清晰层
const PROMOTE_TIMEOUT = 4000;    // ms：清晰层渲染兜底超时，防个别页不回调而卡住
// 页尺寸都还没预取到时的窗口：模块级单例，好让「还是空窗口」这件事在 setState 层面被 Object.is
// 认出来（每次新建一个空对象就等于每次都重渲染）。
const EMPTY_WINDOW: WindowResult = { pages: new Set(), visible: new Set(), rasterScale: 1 };
// 单页预取失败（坏页字典等）时的占位尺寸——用最近一次成功页的尺寸，首页就失败则退到 A4。
// 目的是让 sizes 数组下标始终对齐页号（不能因为一页失败就少 push 一个，让后面的页整体前移），
// 且占位是个真实、非零的尺寸，故意避免下游（本文件的布局、以及 unitLayout）
// 因 0 高度或 null 而出现异常布局或空指针。
// 占位错了只影响那一页自己的行高，不会让后面的页整体偏移——布局模型与 DOM 行高出自同一个
// sizes，不会互相错开。详见下面 layout 处的注释。
export const FALLBACK_PAGE_SIZE: PageSize = { w: 595, h: 842 };
// 没有译文块的页共用这一个空数组：RightPage 的合成 effect 以 blocks 为依赖，每页每次渲染
// 新建一个 [] 会让它每次重渲染都重合成一遍整页位图。
const NO_BLOCKS: Block[] = [];

type Layer = { id: number; scale: number };

// promote() 有三个调用点：onPageSettled 的条件判定、可见集变化后的重判定、PROMOTE_TIMEOUT 兜底。
// 前两个都是「按 promoteReady 条件顶替」，只是触发时机不同（一个来自渲染回调，一个来自可见集
// effect）；第三个是纯计时器兜底，不看任何条件。落到 data-pdf-promote-reason 上，让「这次顶替
// 走的是哪条路」从组件外部（e2e）也能读到——单靠 promoteReady 单测钉不住「端到端真的没卡满
// PROMOTE_TIMEOUT」这件事，因为单测测的是纯函数本身，不是它有没有被实际调用到。
type PromoteReason = 'condition' | 'timeout';

/**
 * 后台新层能不能顶替：**可见页全部 settled**，即 need ⊆ done。
 *
 * 抽成纯函数有两个原因。一是它有两个调用点——渲染回调里一次（新画完一页），可见集变化的
 * effect 里一次；只在回调里判会漏掉「visible 收缩之后剩下的页其实早就画完了」这条路径，
 * 那时没有新回调，没人重新判定，就只能等 PROMOTE_TIMEOUT 兜底。二是这个判据只能用单测钉：
 * 从外面区分「按条件顶替」与「按超时兜底」唯一的可观测差别是墙上时间，拿时间当判据既是
 * 启发式 proxy，也证明不了走的是哪条路。
 *
 * done 允许含 need 之外的页（预取页画完了照样记），多记无害：判据是包含关系，不是相等。
 * need 为空 → false：空集只会在窗口还没算出来（页尺寸没预取完）时出现，那不是「都好了」，
 * 当成 true 会让新层在一页都没画的情况下顶上去。
 */
export function promoteReady(need: Set<number>, done: Set<number>): boolean {
  if (need.size === 0) return false;
  for (const p of need) if (!done.has(p)) return false;
  return true;
}

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

/**
 * 探一次译文边车、写进这个 tab 的译文桶：摘要校验版本、几何过滤越界块（spec §5）。
 *
 * `seq` 就是组件里那个 `translationSeq`：每次发起自增，落地前（成功、失败两条分支各一次）比一次，
 * 失配就整趟作废、什么都不写。它挡的两件事见组件里 `translationSeq` 声明处的注释——其中「关 tab
 * 之后落地」要和下面的 releaseTranslationBucket 配对：那边先把代号推走、再 drop。
 *
 * 抽成模块级函数，是为了让「在途的那趟落地时会不会把桶重建回来」离开 react-pdf 也测得到
 * （PdfFileTab.loadTranslation.test.ts）。什么时候**该**探（翻译作业在跑时不探、bytes / sha
 * 还没就绪时不探）仍由组件里的 loadTranslation 判。
 */
export async function loadTranslationSidecar(
  seq: { current: number },
  a: { tabId: string; pdfPath: string; bytes: Uint8Array; sha: string; sizes: PageSize[] | null },
): Promise<void> {
  const mySeq = ++seq.current;
  try {
    const { doc } = await window.kydog.invoke('pdf.translation.load', { pdfPath: a.pdfPath });
    if (mySeq !== seq.current) return;
    const st = usePdfTranslationStore.getState();
    if (!doc) { st.setLoaded(a.tabId, null, 'unknown', 0); return; }
    const version = checkVersion(doc, a.sha, a.bytes.byteLength);
    const g = a.sizes ? filterByGeometry(doc.blocks, a.sizes) : { blocks: doc.blocks, dropped: 0 };
    st.setLoaded(a.tabId, { ...doc, blocks: g.blocks }, version, g.dropped);
  } catch (err) {
    if (mySeq !== seq.current) return;
    usePdfTranslationStore.getState().setLoadError(a.tabId, (err as Error).message);
  }
}

/**
 * 关 tab 释放译文桶。**先推代号、再 drop**：drop 是同步的，而在途的 loadTranslationSidecar 随后
 * 才 resolve，它的 setLoaded / setLoadError 里有 `?? emptyTBucket()`——代号不推走，就会把桶（连同
 * 整份 TranslatedDoc）原地重建回来，此后再没有人释放它（组件已经卸载，不会再有第二次 drop）。
 */
export function releaseTranslationBucket(seq: { current: number }, tabId: string): void {
  seq.current += 1;
  usePdfTranslationStore.getState().drop(tabId);
}

/**
 * 左栏一页挂载后的那一格：原页（`<Page>` + 标注层）。同时是这一页的挂载边界：React 的
 * mount / unmount 正好对应 pageLifecycle 的 acquire / release，effect 挂在这里最直接。
 *
 * 必须是模块级函数组件，不能定义在 PdfFileTab 内部——定义在组件体内的话每次渲染都是新的函数
 * 引用，React 会把它当成换了一个组件类型，每次渲染都触发一轮 unmount→mount，acquire/release
 * 全乱套（引用计数永远在虚假地归零又回升）。
 *
 * 只接手格子本身；外层带 data-pdf-page、用 size.h/size.w 撑出行高行宽的那层留在 PdfFileTab
 * 里不动——那才是行几何唯一的来源，Plan 1 Task 6 特意要求它不能被拆走、藏进子组件里看不见。
 *
 * **`<Page>` 建在这里而不是留在调用处**：右格要拷这一格画完的 canvas，得有个地方在渲染成功那
 * 一刻把它交出去；这件事天然是逐页逐层的，而调用处是一个 `sizes.map(...)`，循环体里挂不了
 * hook。标注层反过来仍以 ReactNode 从外面传进来（`annotations`），它的一串 props 因此还留在
 * 调用处看得见。
 *
 * 交出去的通道是 `registry`（canvasRegistry.ts）而不是 React state：两格现在分居两栏、两棵树
 * （spec v8 §3.1），提上来做 state 会让每一页 settle 都重渲染整个 PdfFileTab。
 */
function LeftCell({ n, layerId, lifecycle, size, layerScale, registry, onPageLoad, onSettled, annotations }: {
  n: number;
  /** 所在双缓冲层的 id；与页号一起构成注册表的 key（同一页在两层里是两张不同的 canvas）。 */
  layerId: number;
  lifecycle: PageLifecycle;
  size: PageSize;
  layerScale: number;
  registry: CanvasRegistry;
  onPageLoad: (p: PageProxyLike) => void;
  onSettled: () => void;
  /** 标注层；只有清晰层（idx 0）给，后台新层传 null。 */
  annotations: ReactNode;
}) {
  const leftRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    lifecycle.acquire(n);
    return () => lifecycle.release(n);
  }, [n, lifecycle]);

  // 卸载时把自己那张 canvas 从注册表拿掉：右格订阅的正是这一格，别让它继续拷一张已经不在
  // DOM 里的位图（虚拟化滚出窗口、或双缓冲顶替掉整层时都会走到这里）。
  useEffect(() => () => registry.set(cellKey(layerId, n), null), [registry, layerId, n]);

  return (
    // 格子宽度显式给出（而不是收缩到内容宽）：收缩到内容宽会让它取 canvas 的 CSS 宽
    // （react-pdf 对它取过 floor），标注层的坐标换算基准就跟着变了。写死 size.w × scale
    // 与拆格之前的块级布局逐像素一致，也与右栏同页那一格逐字段同源。
    <div ref={leftRef} style={{ position: 'relative', width: size.w * layerScale }}>
      <Page
        pageNumber={n}
        scale={layerScale}
        renderTextLayer={false}
        renderAnnotationLayer={false}
        className="shadow-md"
        onLoadSuccess={onPageLoad}
        onRenderSuccess={() => {
          registry.set(cellKey(layerId, n), leftRef.current?.querySelector('canvas') ?? null);
          onSettled();
        }}
        onRenderError={onSettled}
      />
      {annotations}
    </div>
  );
}

/**
 * 右栏一页挂载后的那一格：译文底图 + 译文块。
 *
 * **不 acquire lifecycle、也不报 settle**：那个引用计数是给 `page.cleanup()` 用的，而这一格
 * 根本不调 pdf.js 渲染（它只从左格 canvas 拷位图）——多 acquire 一次会让页永远清理不掉；
 * 双缓冲的顶替判据同理只认左格画完没有（见 promoteReady），右格插一脚只会让判据失去意义。
 *
 * 左格那张 canvas 靠 `useSyncExternalStore` **只订阅自己这一格**：注册表按 key 通知，别的页
 * settle 不会惊动这里，整个 PdfFileTab 更不会因此重渲染。
 */
function RightCell({ n, layerId, size, layerScale, translating, blocks, docKey, registry }: {
  n: number;
  layerId: number;
  size: PageSize;
  layerScale: number;
  /** 这个 tab 上有翻译作业在跑：底图走空白分支，译文层整层不渲染（spec §1）。 */
  translating: boolean;
  blocks: Block[];
  /** TranslationBlocks 的 fitCache key 隔离维度；调用方传 tab.id。见该组件顶部注释。 */
  docKey: string;
  registry: CanvasRegistry;
}) {
  const key = cellKey(layerId, n);
  const leftCanvas = useSyncExternalStore(
    useCallback((cb: () => void) => registry.subscribe(key, cb), [registry, key]),
    useCallback(() => registry.get(key), [registry, key]),
  );
  // RightPage 每次合成都把**这次实际填下去的底色**交出来；TranslationBlocks 拿它推墨色（Task 7）。
  // null 只有一个含义：这一格还一次都没合成过（底图是空的），不是「探测不到背景色」——探测不到
  // 时 RightPage 交出来的是它退回去填的主题纸色，见该文件的 themePaperRgb。
  const [bg, setBg] = useState<RGB | null>(null);

  return (
    <div style={{ position: 'relative' }}>
      <RightPage
        size={size} rasterScale={layerScale} blocks={blocks} leftCanvas={leftCanvas}
        onBackground={setBg} blank={translating}
      />
      {/* 翻译期间**整层不渲染**，不是渲染成空的：重译时 store 里还留着上一版的块（doc 要等
          新边车落盘才换），照渲染的话右格是「空白底图 + 旧译文浮在上面」。 */}
      {!translating && (
        <TranslationBlocks
          blocks={blocks} size={size} rasterScale={layerScale} bg={bg} docKey={docKey} page={n}
        />
      )}
    </div>
  );
}

/**
 * 每次改缩放前的快照，供缩放后按锚点回算滚动位置（见组件里那个 useLayoutEffect）。
 *
 * `el` 是**这次快照取自哪一栏**，回写也写回它。焦点（focal）相对事件所在栏量，快照就必须同取
 * 那一栏——两个量同源，回算才是恒等的，见下面 requestScale 与那个 useLayoutEffect 的注释。
 */
type ZoomAnchor = { prevScale: number; sl: number; st: number; el: HTMLElement };

/**
 * 视觉缩放（连续值）与它**唯一**的写入口 `requestScale`。
 *
 * 定义在模块级、而不是组件体内，为的是让 `useState` 的 setter 落在组件**够不着的作用域**里。
 * 改缩放这件事有两条随行规矩：
 *   1. 要么记下回算锚点（`zoomAnchor`），要么显式把它清空；
 *   2. 必须排一次清晰层提交（`scheduleCommit`），否则位图会一直停在旧缩放上被 CSS zoom 拉着糊。
 * 原先只有捏合一个调用点，两条规矩写在那个 rAF 里；Task 8 的进/出对照又加了两个调用点，两条
 * 都没跟上——于是「按 L 之后视图跳回上次捏合的位置」「退出对照后位图永久糊着」。收成一个入口
 * 之后这两条由构造成立，不再依赖每个调用点自觉。
 *
 * 这不是把整台缩放状态机（targetScale / layers / promote / 双缓冲）搬家：那些仍留在组件里，
 * 这里只搬走「当前视觉缩放」这一个 state 和写它的那条路径。`scheduleCommit` 由组件注入，
 * 双缓冲的细节这个 hook 一概不知道。
 *
 * `targetScale`（连续累积的目标值）仍是组件的 ref：捏合是**逐 wheel 事件累积、逐帧提交**，
 * 累积那一步不该每次都惊动 React。这里只负责在真正落地时把它对齐到同一个值。
 */
function useVisualScale(
  scrollRef: RefObject<HTMLDivElement | null>,
  focalPane: RefObject<HTMLElement | null>,
  targetScale: RefObject<number>,
  zoomAnchor: RefObject<ZoomAnchor | null>,
  scheduleCommit: () => void,
): [number, (next: number, anchored: boolean) => void] {
  const [visualScale, setVisualScale] = useState(1);
  const cur = useRef(visualScale);
  cur.current = visualScale;

  const requestScale = useCallback((next: number, anchored: boolean) => {
    // 快照取**事件所在的那一栏**（onWheel 每次都写 focalPane，与 focal 同一行来历）。取不到
    // 才退回左栏——非捏合的调用点（进/出对照）走的是 anchored=false，压根不读这个值。
    const el = focalPane.current ?? scrollRef.current;
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    targetScale.current = clamped;
    // anchored=false 时**显式置 null**，不是「不写」：锚点是一次性快照，留着上一次捏合的那份
    // 会让下一次非捏合的缩放（进/出对照）按上次捏合那一刻的滚动位置回算，把视图弹走。
    zoomAnchor.current = anchored && el
      ? { prevScale: cur.current, sl: el.scrollLeft, st: el.scrollTop, el }
      : null;
    setVisualScale(clamped);
    scheduleCommit();
  }, [scrollRef, focalPane, targetScale, zoomAnchor, scheduleCommit]);

  return [visualScale, requestScale];
}

export function PdfFileTab({ tab }: { tab: FileTab }) {
  const setFileTabStatus = useUiStore((s) => s.setFileTabStatus);
  const [bytes, setBytes] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [sizes, setSizes] = useState<PageSize[] | null>(null); // null = 还没预取完；sizes[n-1] 对应第 n 页
  const [currentPage, setCurrentPage] = useState(1);
  // 虚拟化窗口的输入：滚动容器的 scrollTop 与视口高度，都是 CSS px。
  //
  // contentTop / clientHeight 只是 recompute（下面 :293 起）自己的暂存，写、读都在同一次调用
  // 里完成（:296-302），不跨帧留存——放在 ref 上只是图共享读写代码，语义上等价于函数局部变量。
  // contentTop 写入的是 `el.scrollTop / visualScaleRef.current`，读的时候再乘回同一次渲染里
  // 赋值的 `visualScale`（两者由同一次 render 同步写入：下面 visualScaleRef.current = visualScale
  // 和 recompute 这个闭包捕获的 visualScale，出自同一次 render body 的执行，恒是同一个数）——
  // 一除一乘精确相消，`top` 就是 `el.scrollTop` 本身，不是什么独立的「内容坐标」。
  //
  // 这次现读是准的：recompute 无论从哪条路径被调用——缩放提交后的 effect，还是滚动帧的 rAF
  // 回调（scheduleRecompute）——读到的都是调用那一刻 DOM 里的 scrollTop。缩放提交那条路径
  // 尤其要紧：它的 effect（下面 `useEffect(() => { recompute(); }, [recompute])`）排在按鼠标
  // 锚点回算滚动位置的 useLayoutEffect 之后、同一次 commit 里跑（见下方缩放锚点那段），所以
  // 此刻读到的 scrollTop 已经是按新缩放校正过的值，不是校正前的旧位置。
  //
  // 为什么是 ref 不是 state：这两个量每个滚动帧都变，而由它们算出来的窗口大多数帧不变。放
  // state 的话每帧都是一次新值，整棵 PdfFileTab 子树（含 <Document> 与 N 个页行 div）每帧
  // 重渲染一次——正好把虚拟化省下来的开销从位图搬到 reconcile 上。真正驱动渲染的是下面那个
  // 派生出来的 win（recompute 只在窗口真的变了时才 setWin），它的变化频率低得多。
  const contentTop = useRef(0);
  const clientHeight = useRef(0);
  const pageProxies = useRef<Record<number, PageProxyLike>>({});
  // 文档 proxy，翻译时按页现取用。pageProxies 只有**预取成功**的页有份（单页预取失败会缺一格，
  // 见 prefetchPageSizes），而翻译要在每一页上抽文本，缺的那页得有地方能补取到。
  // 只留 getPage 一个方法，不把 react-pdf 的内部类型引进来（同上面 PageProxyLike 的理由）。
  const pdfRef = useRef<{ getPage: (n: number) => Promise<PageProxyLike> } | null>(null);
  const linesCache = useRef<Record<number, Promise<TextLine[]>>>({});
  // 什么时候把一页还给 pdf.js（page.cleanup()）由 pageLifecycle.ts 的引用计数决定，挂载/卸载
  // 边界在 LeftCell。PageProxyLike 故意没声明 cleanup（那是给 ensureLines 用的最小
  // 接口），这里单独转型取用。
  const lifecycle = useRef<PageLifecycle>(createPageLifecycle(
    (n) => pageProxies.current[n] as unknown as Cleanable | undefined,
  ));
  // 测试探针的累加器：翻译抽取那条路上还回去了几页（见 startTranslation 的 onPageExtracted）。
  const translateCleaned = useRef(0);
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

  // 字节摘要只算一次：bytes 在一个 tab 生命周期里只会从 null 变成一份字节、此后不再变（见下方
  // "加载 PDF 字节"那个 effect，只在 tab.status === 'loading' 时才 setBytes）。loadTranslation
  // 会在 sizes 到位、以及每次窗口 focus 时重跑（见下）——若每次都重算 sha256，开着 N 个 PDF、
  // alt-tab 回来一次就是 N 次对整份字节的全量哈希。算好存这里，loadTranslation 直接读，不再自己算。
  // 例外：md 导出 PDF 后点「打开」，若同路径的 PDF 标签已开着，MarkdownFileTab.tsx 的
  // openExported 会在同一次点击里 closeFileTab 再 openFile——MainPane 按 tab.id 挂 key，这仍是
  // 同一个组件实例，但 props 换成一个全新的 tab 对象（status 回到 'loading'），下面「加载 PDF
  // 字节」那个 effect 因此重跑，bytes 会再变一次（不经过 null，直接被新读出来的字节覆盖）。
  // 上面「只会从 null 变成一份字节、此后不再变」说的是同一个 tab 对象在场的这段时间，不是这个
  // 组件实例的整个生命周期——这不是把下面这个 effect 的依赖数组收窄成只跑一次的理由，
  // 它必须继续依赖 `bytes` 本身（而不是比如换成一个「算过了」的 ref 标记）。
  const [sha, setSha] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) { setSha(null); return; }
    let cancelled = false;
    sha256Hex(bytes)
      .then((h) => { if (!cancelled) setSha(h); })
      .catch((err: Error) => {
        if (!cancelled) usePdfTranslationStore.getState().setLoadError(tab.id, err.message);
      });
    return () => { cancelled = true; };
  }, [bytes, tab.id]);

  // 加载译文边车：摘要校验版本、几何过滤越界块（spec §5）。
  // 几何过滤要等页尺寸预取完；sizes 还没到（首次挂载时几乎总是如此）就先按未过滤存一版，
  // sizes 到位后这个 effect 靠依赖数组里的 sizes 再跑一次，用真实尺寸重新过滤、覆盖前一版。
  //
  // sha 是异步算出来的，这个 effect 可能在它算好之前就先跑一次（比如 sizes 先到、或首次挂载时
  // bytes 刚落地那一刻）——这时直接不做事（不取边车、不写 store），等上面那个 effect 把 sha
  // 算好、这个 useCallback 因依赖变化换引用，"跑一次"的 effect（下面）自然会重新触发。没有选
  // "先按 unknown 存一版、sha 到位后再单独重判"：那条路要么得再拉一次边车 RPC，要么得把 doc
  // 存到 ref 里跨两次调用复用，多一条状态路径；而 sha256 是纯本地计算，收敛比边车 RPC 更快，
  // 等它没有可觉察的代价。选择"等"是为了不让版本校验在 sha 未就绪的窗口里把 unknown 当成
  // 阶段性正确答案去展示——bucket 在这段窗口里维持"还没加载"的初始状态，不会被写入。
  //
  // 取消与代际：`translationSeq` 在每次发起时自增，落地前比一次。它同时挡住两件事——
  //   1. **关 tab 之后落地**：卸载的 cleanup（下面释放译文桶那个 effect）也把它自增一次，于是
  //      在途的这趟落地时代号已经失配，不会在 `drop(tab.id)` 之后又把桶（连同整份 TranslatedDoc）
  //      靠 setLoaded 里的 `?? emptyTBucket()` 重建回来、此后永不释放。
  //   2. **两趟并发时先发后至**：这个函数有两个调用点（下面「跑一次」的 effect、以及窗口 focus
  //      重探），sizes 落地与一次 focus 撞在一起时会有两趟在途。没有代际标记的话，先发的那趟
  //      （sizes 还是 null、blocks 未经几何过滤、dropped 恒为 0）若后到，就会覆盖掉后发那趟
  //      已经过滤好的结果。
  // 标注那条加载器（上面）只有一个调用点、也不会重入，用一个 `cancelled` 闭包就够；这里的两条
  // 都是「哪一趟才算数」的问题，闭包标记表达不了，只能用代号。
  const translationSeq = useRef(0);
  // 作业代际。挡三条真实竞态（spec §9.1）：取消后立刻重启时，旧作业的续体会把新作业的 job
  // 清掉或把旧进度写回去；关 tab 后旧续体靠 setJob 里的 `?? emptyTBucket()` 把桶原地重建回来；
  // 失败路径的 catch 同样要过代际，否则一趟已经作废的作业照样会把单栏状态写回去。
  const jobSeq = useRef(0);
  const loadTranslation = useCallback(async () => {
    // 翻译进行中不重探边车：此刻盘上还是旧边车（重译）或压根没有（首次翻译），而 setLoaded 在
    // doc === null / version 变 mismatch 时都会把 dual 收掉（一期为「边车被删就自动退出对照」
    // 写的）——focus 重探每次切窗口都会发生，会把用户踢出刚进的对照（spec §9.2）。
    if (usePdfTranslationStore.getState().buckets[tab.id]?.job) return;
    if (!bytes || sha === null) return;
    // 这一趟真的要去探边车了：无论探出什么（成功、mismatch、结构坏了……），都比一次旧作业
    // 留下的 translateError 更新——不清掉的话它会常驻并压住这里探出来的任何结果（Task 14
    // 审查发现：PdfAnnotationNotice 把 translateError 排在 loadError / mismatch 之前，见
    // startTranslation 头上关于清除时机的注释，这是另一个清除点，两处各管一类触发源：这里管
    // 「自动重探」，那边管「用户按下新动作」）。
    setTranslateError(null);
    // 代号的自增与落地前的比对都在它里面（见模块级 loadTranslationSidecar）。
    await loadTranslationSidecar(translationSeq, { tabId: tab.id, pdfPath: tab.path, bytes, sha, sizes });
  }, [bytes, sha, sizes, tab.id, tab.path]);

  useEffect(() => { void loadTranslation(); }, [loadTranslation]);

  // 边车是点号开头的文件，fileWatcher 的 ignored 会跳过它，agent 写完译文边车之后不会有
  // file.changed 事件——不给 watcher 开后门，改成窗口重新拿到焦点时重探一次（spec §3.4）。
  useEffect(() => {
    const onFocus = () => { void loadTranslation(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadTranslation]);

  // 关 tab 释放译文桶：与标注桶分开释放（下面那个 effect），译文本期只读、没有草稿/未落盘改动
  // 要冲，drop 不需要跟 flushDrafts/saveScheduler 那套顺序绑在一起。
  // 自增代号那一步不能省：drop 是同步的，而在途的 loadTranslation 随后才 resolve，
  // 它的 setLoaded 会把桶原地重建回来（见 loadTranslation 头上的注释）。
  useEffect(() => () => {
    // 在途的翻译作业与在途的边车加载同理：它的续体也会走 setJob，把桶原地重建回来（spec §9.1
    // 第 2 条），所以作业代号也得赶在 drop 之前推走。
    jobSeq.current += 1;
    releaseTranslationBucket(translationSeq, tab.id);   // 推 translationSeq、再 drop
  }, [tab.id]);

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

  // 滚动帧：按 rAF 节流，重读滚动几何并重算窗口与页码读数（recompute 在下面，它要用到
  // sizes/layout/editingPage，得等它们先声明；这里走 ref 拿最新的一版，好让这个回调本身的
  // 引用恒定——它是 scroll 监听器的入参，换引用就要重挂监听）。
  const scheduleRecompute = useCallback(() => {
    if (readoutRaf.current != null) return;
    readoutRaf.current = requestAnimationFrame(() => {
      readoutRaf.current = null;
      recomputeRef.current();
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
  // 最近一次顶替走的是哪条路（见上面 PromoteReason 的注释）；只落在 stable 层上（见渲染处）。
  // 新一轮双缓冲开始（后台新层刚创建）时清空——2 层并存期间这个值属于上一轮，不该被读到。
  const [promoteReason, setPromoteReason] = useState<PromoteReason | null>(null);

  const wrapperRef = useRef<HTMLDivElement>(null);
  // 左栏是 master：窗口计算、页码读数、缩放锚点、ResizeObserver 全读它（spec v8 §3.1）。
  const scrollRef = useRef<HTMLDivElement>(null);
  // 右栏是 mirror，只在对照时存在。
  const rightRef = useRef<HTMLDivElement>(null);
  // 左栏占 wrapper 可用宽的比例。只活在这个 tab 的组件 state 里，**不持久化**（spec v8 §3.1）。
  const [split, setSplit] = useState(0.5);
  // 拖分隔线期间给 wrapper 上 user-select: none，免得横扫时把译文块的文字一路选中。
  const [dragging, setDragging] = useState(false);
  // wrapper 的 clientWidth。左栏宽给的是**像素**而不是百分比：两栏尺寸要逐字段可推，
  // 百分比 + 分隔线像素会让右栏宽变成一个减法结果，对不上 paneWidths 的算法。
  const [wrapperW, setWrapperW] = useState(0);
  // 左格画完的 canvas 交给右格的通道（canvasRegistry.ts）。ref 持有：每个 tab 一份、跨渲染恒定。
  // 懒初始化（Minor #5，Task 2 审查发现）：`useRef(createCanvasRegistry()).current` 那种写法
  // 每次渲染都会先调用一遍 createCanvasRegistry()——它的返回值确实只在首次渲染被采用，但函数
  // 本身每次都执行，白造两个 Map 加几个闭包再丢弃。捏合手势逐帧重渲染，这笔白造的开销按帧计。
  // 判断 `!ref.current` 才真正创建一次，此后原样复用同一个实例。
  const registryRef = useRef<CanvasRegistry | null>(null);
  if (!registryRef.current) registryRef.current = createCanvasRegistry();
  const registry = registryRef.current;
  const layerSeq = useRef(0);
  const targetScale = useRef(1);              // 连续累积的目标缩放
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const rafRef = useRef<number | null>(null);
  const commitTimer = useRef<number | null>(null);
  const promoteTimer = useRef<number | null>(null);
  // 新层渲染进度：按页号存，不是计数——同一页 onRenderError 之后又 onRenderSuccess 不能重复计数
  const progress = useRef<{ id: number; done: Set<number> }>({ id: -1, done: new Set() });
  const focal = useRef({ x: 0, y: 0 });       // 缩放锚点：鼠标相对**事件所在那一栏**视口的位置
  // 上面那个 focal 是相对谁量的。与 focal 在 onWheel 里同一行写入，两者恒配对——锚点快照
  // 必须取同一个元素，见 ZoomAnchor 的注释。
  const focalPane = useRef<HTMLElement | null>(null);
  const zoomAnchor = useRef<ZoomAnchor | null>(null);

  // 要挂载哪些页、以多细的位图挂——两件事一起定（pageWindow.ts）。
  //
  // 不是 useMemo：它的输入里有一个每帧都变的量（滚动位置），而输出大多数帧不变。改成「算出来
  // 与上一版是同一个窗口就原样返回上一版」（sameWindow），React 的 Object.is 就会把这次
  // setState 整个 bail out——纯滚动于是大多数帧一次重渲染都没有。判据是算出来的窗口本身，
  // 不是滚动了多少像素，没有阈值。
  const [win, setWin] = useState<WindowResult>(EMPTY_WINDOW);
  // onWheel / onPageSettled 都挂在 effect 或回调里，闭包拿不到最新的 win，用 ref 镜像
  const winRef = useRef(win);
  winRef.current = win;

  // 把后台新层提升为唯一的清晰层（旧层同时移除）。reason 记录这次顶替是被哪条路触发的
  // （见 PromoteReason 的注释），落进 state 供渲染层挂到 stable 层的 data 属性上。
  const promote = useCallback((reason: PromoteReason) => {
    if (promoteTimer.current != null) { clearTimeout(promoteTimer.current); promoteTimer.current = null; }
    setPromoteReason(reason);
    setLayers((cur) => (cur.length > 1 ? [cur[cur.length - 1]] : cur));
  }, []);

  // 排一次「停顿 COMMIT_DELAY 之后在后台以新缩放渲染一层清晰层」。
  //
  // 由 requestScale 统一调用（见模块级 useVisualScale）：**任何**改缩放的路径都会经过它，
  // 而不只是捏合。少排一次的后果是位图停在旧缩放、被外层 CSS zoom 拉着糊，且在用户下一次
  // 捏合之前不会自愈——退出对照那条路径原先就是这样。
  const scheduleCommit = useCallback(() => {
    if (commitTimer.current != null) clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => {
      commitTimer.current = null;
      const stable = layersRef.current[0];
      // 用窗口算出来的栅格分辨率，不是视觉缩放：视觉超出预算上界的那部分由外层 CSS zoom
      // （渲染处的 visualScale / layer.scale）补，表现为「放到很大只是变糊」，而不是把位图撑爆。
      const target = winRef.current.rasterScale;
      if (Math.abs(target - stable.scale) < 0.001) {
        // 已是该缩放：丢弃任何未完成的新层，连同它的兜底计时器与上一轮的顶替结论。
        // 不清的话 data-pdf-promote-reason 会挂着上一轮的答案，而这一轮压根没顶替过；
        // 计时器不清则会在 4 秒后拿 'timeout' 去覆盖它——两者都在削弱这个属性的可观测性。
        if (promoteTimer.current != null) { clearTimeout(promoteTimer.current); promoteTimer.current = null; }
        setPromoteReason(null);
        setLayers([stable]);
        return;
      }
      layerSeq.current += 1;
      const incoming: Layer = { id: layerSeq.current, scale: target };
      progress.current = { id: incoming.id, done: new Set() };
      setPromoteReason(null); // 新一轮双缓冲开始：上一轮的顶替原因作废，还没轮到这一轮的结论
      setLayers([stable, incoming]);
      if (promoteTimer.current != null) clearTimeout(promoteTimer.current);
      promoteTimer.current = window.setTimeout(() => promote('timeout'), PROMOTE_TIMEOUT);
    }, COMMIT_DELAY);
  }, [promote]);

  // 上面这两个计时器的清理**放在一个不设门的 effect 里**，与「排」同域。
  //
  // 原先它写在下面那个捏合 effect 的 cleanup 里——那时 scheduleCommit 的代码本身就在那个 effect
  // 内部，排与清天然同域。抽出来之后不再是：那个 effect 开头是 `if (tab.status !== 'ready') return;`
  // （不注册 cleanup），而 requestScale 现在还有一个**不设门**的调用点（退出对照的还原 effect）。
  // 今天不可达——ready → error 只可能来自 <Document> 的 onLoadError，它与 onLoadSuccess 互斥，
  // 没有 onLoadSuccess 就没有 sizes、进不了对照——但「不可达」是一条要每次重新论证的性质，
  // 而不设门的 cleanup 让配对由构造成立。同 readoutRaf 上面那条。
  //
  // 代价是 tab.status 离开 ready 时不再顺手取消在途的提交：那时组件还挂着，计时器触发也只是
  // setLayers / setPromoteReason，错误态下什么都不渲染；真正要紧的卸载路径反而从「看状态」变成了
  // 无条件。
  useEffect(() => () => {
    if (commitTimer.current != null) clearTimeout(commitTimer.current);
    if (promoteTimer.current != null) clearTimeout(promoteTimer.current);
  }, []);

  const [visualScale, requestScale] = useVisualScale(scrollRef, focalPane, targetScale, zoomAnchor, scheduleCommit);
  const visualScaleRef = useRef(visualScale);
  visualScaleRef.current = visualScale;

  // 每页顶边偏移与内容总高，按预取到的页尺寸算——虚拟化之后窗口外的行没有内容可量，
  // 只能算（pageLayout.ts）。
  //
  // sizes 里可能混着占位尺寸（某页预取失败时 prefetchPageSizes 拿上一页的尺寸顶上，首页就
  // 失败则用 FALLBACK_PAGE_SIZE）。它**不会**让后面的页整体错位：DOM 里每一行的高度出自
  // 同一个 sizes（`size.h * layer.scale`），gap/padding 两边同样按 layer.scale 等比、外层
  // zoom 抵掉，所以行的实际顶边恒等于 tops[k] × visualScale——模型与 DOM 用的是同一份数据，
  // 哪怕这份数据是错的，两者也不会互相错开，窗口不会偏。
  // 真实后果只落在那一页自己身上：它的行是错的高度。若该页后来居然渲染成功（预取时 getPage
  // 瞬时失败、<Page> 却成功），它的 canvas 会溢出这个行或缩在行里；若始终失败，就只是留下
  // 一个尺寸不对的空位。
  const layout = useMemo(() => (sizes ? unitLayout(sizes, PAGE_GAP, PAGE_PAD) : null), [sizes]);

  // Task 7 之前这里恒为 null（store 里有槽位、还没有写入方），窗口逻辑照常工作。
  const editingPage = usePdfAnnotationStore((s) => s.buckets[tab.id]?.editingPage ?? null);

  // 双栏对照：写入方是下面的 onToggleDual（工具栏翻译键的 onClick 与 annotationKeys.ts 的
  // L 分支都调它），以及 setLoaded 在 doc 变 null / version 变 mismatch 时的自动退出。
  // 页尺寸预取完没有，写进译文桶：进对照要用第一页的宽度算 fit-width，sizes 没到就只能什么都
  // 不做。原先这条不进判据，翻译键在预取期间仍是 enabled，按下去静默无事发生（大文档预取几百
  // 页时这段窗口不短）。放进 store 而不是只在工具栏里判，是为了让工具栏与 `L` 键共用同一份
  // 判据——两处各判一次是最难查的那类 bug。
  useEffect(() => {
    usePdfTranslationStore.getState().setLayoutReady(tab.id, sizes !== null);
  }, [tab.id, sizes]);

  const dual = usePdfTranslationStore((s) => s.buckets[tab.id]?.dual ?? false);
  // 正在跑的翻译作业。它同时是三个开关：右格走空白分支、译文层整层不渲染、浮层显不显示。
  const job = usePdfTranslationStore((s) => s.buckets[tab.id]?.job ?? null);
  const translated = usePdfTranslationStore((s) => s.buckets[tab.id]?.doc ?? null);
  // 按页分桶一次，而不是在页行的 map 里逐页 filter：filter 每次渲染都产出新数组，
  // 会让 RightPage 的合成 effect（依赖 blocks）每次重渲染都重合成一遍整页位图。
  const blocksByPage = useMemo(() => {
    const m = new Map<number, Block[]>();
    if (translated) {
      for (const b of translated.blocks) {
        const bucket = m.get(b.page);
        if (bucket) bucket.push(b); else m.set(b.page, [b]);
      }
    }
    return m;
  }, [translated]);

  /**
   * 进对照，按需 fit-width（spec §12）。两个调用点：下面 onToggleDual 的 `ready` 分支（已经有
   * 可用译文，直接看），以及 startTranslation（点翻译**先进对照**，右格空白等结果）。抽成一段
   * 是因为两条路的几何处理必须一模一样——分成两份写就会在缩放上分叉，而这类分叉只有用户在两条
   * 路之间来回切时才看得见。
   *
   * fit 对着**较窄那一栏**（fitToNarrower，spec v8 §3.1）：两栏可以不等宽，对着宽栏 fit 会让
   * 窄栏被裁，对着窄栏 fit 顶多让宽栏留白——留白比裁掉好。栏宽从 wrapper 的 clientWidth 与当前
   * 比例现算（paneWidths），不读两个 DOM 元素：进对照这一刻右栏还没挂上，读不到。
   *
   * **栏宽要扣掉纵向滚动条的厚度**（Important #1，Task 2 审查发现）：`paneWidths` 切的是
   * wrapper 的 border-box 宽（wrapper 自己无滚动条），而两栏各自的可用宽是它们各自的
   * `clientWidth`（= border-box − 滚动条占位厚度）——两栏现在是覆盖式滚动条（Task 2），`bar`
   * 恒为 0；保留这份实测是为了这条判据不依赖这一点。不扣的话 `pageW × fit` 会比栏的
   * `clientWidth` 宽出这一份厚度，两栏各自长出一条横向滚动条、页面右缘被裁。
   *
   * `bar` 不是一个猜出来的常量：这一刻左栏还没进对照、仍铺满整条 wrapper，`wrap.clientWidth`
   * 与 `scrollRef.current.clientWidth` 量的是同一个元素的 border-box 宽与内容盒宽，两者之差就
   * 是**此刻实测的**纵向滚动条厚度——文档没有纵向滚动条（页数少、装得下一屏）时它恰好是 0，
   * 不是每次都硬扣 8px。两栏各自也会有一条纵向滚动条，同一个 bar 从两栏宽里各扣一次。
   *
   * 页宽用 sizes[0]：fit-width 只需要一个近似的「装不装得下」判断，多数论文各页同宽，用第一页
   * 的宽度足够；量出来的 fit 又会被 requestScale 的 MIN_SCALE 兜底，极端情况下也不会缩到不可用。
   * 放不下就缩到刚好放下，把进入前的缩放存进 prevScale；本来就放得下则不动、prevScale 存 null。
   *
   * **已经在对照里就一步都不做**：对照中重新翻译会走到这里，那时既不该再动一次缩放，更不该拿
   * 此刻这个 fit 值去覆盖 prevScale——那份是「还没被消费的还原请求」，覆盖掉的话退出对照就会
   * 还原到 fit 自己，等于不还原。
   */
  const enterDualFitWidth = useCallback(() => {
    const st = usePdfTranslationStore.getState();
    const wrap = wrapperRef.current;
    const el = scrollRef.current;
    if (!wrap || !el || !sizes || st.buckets[tab.id]?.dual) return;
    const bar = wrap.clientWidth - el.clientWidth; // 此刻实测的纵向滚动条厚度，见上方注释
    const { left, right } = paneWidths(wrap.clientWidth, split);
    const fit = fitToNarrower(left - bar, right - bar, sizes[0].w);
    const prev = visualScaleRef.current;
    if (fit < prev) {
      st.setDual(tab.id, true, prev);
      // 非捏合的缩放：锚点显式清空（anchored=false），否则会拿上一次捏合的快照回算滚动位置
      requestScale(fit, false);
    } else {
      st.setDual(tab.id, true, null);
    }
  }, [tab.id, sizes, split, requestScale]);

  // 翻译失败的原因，交给 Notice 显示（PdfAnnotationNotice 的 translateError prop）。
  //
  // 清除时机（Task 14 审查发现：原先只在下一次作业**开始**时清，没有别的清除点——一次失败之后
  // 这条消息会在这个 tab 上常驻，因为 PDF tab 是 display:none 保留挂载、不随切换卸载，而 Notice
  // 把它排在 loadError / mismatch / unknown / dropped 全部之前，压住了此后任何更新更准确的
  // 提示）。两处都清，各管一类触发源，不是重复：
  //   1. startTranslation 开头（下面）——用户按下「翻译 / 重新翻译」这个新动作，旧错误对这一趟
  //      已经不成立。
  //   2. onToggleDual 入口（下面）——分派函数本身，覆盖「进 / 出对照」这两支不经过
  //      startTranslation 的路径（active 态退出、ready 态直接进），同时对 startTranslation 那支
  //      冗余但无害。
  //   3. loadTranslation 里（上面）——没有用户动作、纯自动重探（挂载 / sizes 到位 / focus）也要
  //      清：它探出来的结果（哪怕仍是「没有译文」）就此刻而言比一次旧作业留下的错误更新。
  const [translateError, setTranslateError] = useState<string | null>(null);

  // 这趟作业**开始前** dual 是不是已经为 true——只有从对照中发起重译（active 态点「重新翻译」
  // 键）才会是 true，从 none/invalid/mismatch 发起翻译时恒为 false。错误与取消两个出口都要
  // 读它（见下方 catch 与 cancelTranslation）：已经在对照中发起的重译一旦失败或被取消，不该把
  // 用户踢出这个本来完好的对照视图——store 里那份旧 doc 还在。用 ref 而不是局部变量，是因为
  // cancelTranslation 是与 startTranslation 分开的一个回调，读不到后者调用时的局部变量。
  // **读取约束（这条让它成立的前提没写出来就是个坑）**：只允许在「恰好有一趟 job 存活」时读。
  // 写入方是 startTranslation 每次调用的**开头**，每次新作业一开始就覆写——所以只要 job 非
  // null，它挂着的必然是**这唯一一趟**活跃作业的值，不会有陈旧值的空间（不存在两趟并发的
  // job：新一趟开始前旧一趟早已经过代际比较判负）。两个读取点分别踩这条前提：catch 分支在
  // 同一次调用里读，隔着若干 await，靠 `my === jobSeq.current` 先挡过期续体；cancelTranslation
  // 是独立回调、没有 `my` 可比，它读得对是因为「取消」按钮只在 **job 非 null 且 dual** 时才会
  // 渲染（TranslationProgress 挂在渲染树里 `dual && (...)` 那层下面，不是单靠 job 判的）——而
  // `job ⇒ dual` 由 startTranslation 自己的调用顺序绑死（Important #2，Task 2 审查发现：见下面
  // 「进对照是发起作业的前置条件」那段），job 非 null 时 dual 必然也是 true，所以点得到取消键
  // 的那一刻前提必然成立。job 是 null 时这个 ref 的值没有任何意义，也没有代码会在那时去读它。
  const wasDualRef = useRef(false);

  /**
   * 跑一趟翻译流水线（spec §7）：立刻进对照 → 右格空白 + 进度浮层 → 抽取 → 逐页翻译 → 写边车
   * → 走**现有的** loadTranslation() 重新加载 → 右格开始正常合成。
   *
   * 编排本身在 translateDoc（纯逻辑、可单测）；这里只负责把它接上 IPC、代际与 store。
   */
  const startTranslation = useCallback(async (opts?: { pages?: number[] }) => {
    if (!sizes || !bytes || sha === null || !numPages) return;
    // 守卫下沉到这里（Minor #4，Task 14 审查发现）：原来只有 onToggleDual 一个调用点在自己
    // 那边判过 canPressTranslate，onRetranslate 直接调这个函数、没经过那道判断——「重新翻译」
    // 键只在 active 态渲染，正常点击时判据恒为真，但让这个真正做状态改动的函数本身对「不该进」
    // 的调用也安全，好过要求每个调用点都记得先判一遍（本文件另一处同样原则的注释见 onToggleDual）。
    if (!canPressTranslate(usePdfTranslationStore.getState().buckets[tab.id])) return;
    // **进对照是发起作业的前置条件**（Important #2，Task 2 审查发现）：浮层与取消按钮都在渲染树
    // 的 `dual && (...)` 里面（见下方 JSX），job 非 null 而 dual 仍是 false 的话，用户看不到
    // 进度、点不到取消，作业只能干等它自己跑完——`job ⇒ dual` 因此是一条承重不变量。
    // `enterDualFitWidth` 在 `!wrap || !sizes` 时不设 dual 就返回；`sizes` 已经在函数开头判过，
    // 唯一还可能落空的是 `!wrap`——今天不可达（wrapper 与 scrollRef 总是先于按钮可点而挂载），
    // 但「不可达」是一条每次改动都要重新论证的性质，不该是这条不变量成立的唯一理由。所以在这里
    // 老老实实读一次刚落地的 store：dual 仍不是 true 就整个函数当场退出，**不推进任何代际、
    // 不 setJob**——不变量由构造成立，不依赖「这两个分支今天恰好都不会走到」这种默契。
    wasDualRef.current = usePdfTranslationStore.getState().buckets[tab.id]?.dual ?? false;
    enterDualFitWidth();
    if (!usePdfTranslationStore.getState().buckets[tab.id]?.dual) return;
    // 启动作业时**两个代际一起推进**：jobSeq 是这趟作业自己的代号；translationSeq 自增是为了
    // 作废「作业启动前就已经在途」的那趟 load——它的代号仍等于 current，会照常落地，而那时盘上
    // 还是旧边车（或压根没有），setLoaded 会把 dual 收掉，用户刚进对照就被踢出来（spec §9.2）。
    // 只加 loadTranslation 开头那道 `job` 闸挡不住它：那道闸只管**之后**发起的重探。
    const my = ++jobSeq.current;
    translationSeq.current += 1;
    const st = usePdfTranslationStore.getState();
    const locale = useSettingsStore.getState().settings?.ui.locale ?? 'zh';
    // 部分跑（重译本页 / 重试失败页）第一帧的进度总量该是这一趟真要跑的页数，不是全篇页数——
    // 否则浮层先闪一下「0 / numPages」，等第一条 tick 回来才跳到真实总量。
    st.setJob(tab.id, { phase: 'extract', done: 0, total: opts?.pages?.length ?? numPages, failed: 0 });
    setTranslateError(null);
    // 这一趟真正落地的失败页数与页数总量，只给下面 finalize 那一档进度用：只有 'translate'
    // 阶段的 tick 才是真值——'finalize' 那一档是我们自己合成的（下面），不能拿它回头覆盖自己。
    // job 跑完（Promise.all 收尾）时最后一次 'translate' tick 携带的就是全部页跑完的最终数字。
    //
    // **「哪几页失败」不从这里往下游传**：它由 translateDoc 写进 doc.failedPages、跟着边车落盘
    // （zhSidecar.ts），Notice 从 store 里那份 doc 现读。所以取消 / 出错 / 重译中途这些出口
    // 一行都不用管它——doc 没变，提示就没变。
    let lastFailed = 0;
    let translated = 0;
    try {
      const model = await window.kydog.invoke('pdf.translation.resolveModel', {
        threadId: useThreadsStore.getState().currentThreadId,
      });
      // 部分跑（重译本页 / 重试失败页）的 base 必须是盘上的原文（协议层事实），不能拿
      // store 里那份 doc：它在 loadTranslation 里已经被 filterByGeometry 过滤过一轮
      // （spec §5），越界块从内存中的 doc.blocks 里丢掉了。拿它当 base 交给 translateDoc
      // 合并、再整份落盘，等于把那些块从磁盘上永久抹掉——违反 spec §8 不变量 #7。这里
      // 与 resolveModel 那次 await 一样受 `my === jobSeq.current` 的代际保护：若在等待期间
      // 被取消 / 关 tab，doc 为 null 时会抛错走下面的 catch，那里已经比过代际再决定要不要
      // 写 store。
      let base: TranslatedDoc | undefined;
      if (opts?.pages) {
        const { doc: loaded } = await window.kydog.invoke('pdf.translation.load', { pdfPath: tab.path });
        if (!loaded) throw new Error('译文文件已不存在，请重新翻译');
        base = loaded;
      }
      // 术语表跨重译保留：它是用户 / agent 写进边车的约定，不是这一趟翻译的产物（spec §2.6）。
      // 部分跑优先取**刚探到的盘上原文**：store 里那份 doc 是 filterByGeometry 过滤过的内存
      // 副本，与 base 同一个理由（见上面那段注释）。全量跑没有 base，退回 store 那份，行为不变。
      const keepGlossary = base?.glossary ?? st.buckets[tab.id]?.doc?.glossary;
      const doc = await translateDoc({
        numPages,
        getPage: async (n) => {
          const cached = pageProxies.current[n];
          if (cached) return cached;
          const d = pdfRef.current;
          if (!d) throw new Error(`第 ${n} 页还没准备好，无法抽取原文`);
          return d.getPage(n);
        },
        // 两步协议（spec 2026-09-07 §4）：第一步只分组分类（不需要 langOut / glossary），
        // 第二步按组翻译。编排、解析、补漏都在 translateDoc，这里只把两个入口接上 IPC。
        layoutPage: (a) => window.kydog.invoke('pdf.translation.layout', {
          page: a.page, lines: a.lines, docTitle: a.docTitle,
          providerId: model.providerId, modelId: model.modelId, runtimeRevision: model.runtimeRevision,
        }),
        translateGroups: (a) => window.kydog.invoke('pdf.translation.translate', {
          page: a.page, groups: a.groups, docTitle: a.docTitle,
          providerId: model.providerId, modelId: model.modelId, runtimeRevision: model.runtimeRevision,
          langOut: locale, glossary: keepGlossary,
        }),
        onProgress: (p) => {
          if (my === jobSeq.current) usePdfTranslationStore.getState().setJob(tab.id, p);
          if (p.phase === 'translate') { lastFailed = p.failed; translated = p.total; }
        },
        isCancelled: () => my !== jobSeq.current,
        // 抽取顺带把文本行交出来，标注层随后要吸附就不必再取一遍（spec §4）；同一时刻把这一页
        // 还给 pdf.js（不变量 #8）——不然翻一份 200 页的论文 = 200 页 getTextContent() 的解析
        // 结果一直驻留到关 tab，只为了抽一次文本。
        //
        // **lifecycle.sweep() 兜不住这条**，所以 proxy 必须由这里直接交进去：翻译走的是
        // pdfRef.current.getPage(n) 现取，这些页从来没 acquire 过，也不一定在 pageProxies 里，
        // sweep 循环的是 refs、run() 又只认 getProxy —— 两头都找不到它们。判据仍是 lifecycle
        // 那一条（不在窗口内 + 没有任何层持有），窗口用 winRef：这个回调挂在 useCallback 的闭包
        // 里，读 win 这个 state 拿到的是作业启动那一刻的旧值。
        onPageExtracted: (n, text, src) => {
          linesCache.current[n] = Promise.resolve(text);
          const before = lifecycle.current.cleanedCount();
          lifecycle.current.cleanupIfIdle(n, src as unknown as Cleanable, winRef.current.pages.has(n));
          // 测试探针：**这条路上**真的还回去了几页。取 cleanedCount 的差值而不是自己数一遍，
          // 是为了让探针没法与实际动作脱节（「决定要清」但没清就不该计数）。单开一个计数而不
          // 复用 __kydogCleanedPages，是因为进对照本身会改窗口、也会让 sweep 清掉几页——共用
          // 一个数就分不清这次增长是谁贡献的，断言退化成「有人清过」。
          translateCleaned.current += lifecycle.current.cleanedCount() - before;
          (window as unknown as { __kydogTranslateCleanedPages?: number })
            .__kydogTranslateCleanedPages = translateCleaned.current;
        },
        pdfName: tab.path.split(/[\\/]/).pop()!,   // 渲染层没有 node:path
        langOut: locale,
        source: { sha256: sha, bytes: bytes.byteLength },
        glossary: keepGlossary,
        // 部分页（重译本页 / 重试失败页）：只翻 pages、与盘上原文合并（spec 2026-09-06 §4.3）。
        // base 已经在上面重新探过盘（见那段注释）；这两个键只在 active 态渲染，正常路径下
        // base 必然非空——万一盘上此刻确实没有文件，上面已经抛出「译文文件已不存在」，走不到这里。
        pages: opts?.pages,
        base,
      });
      if (my !== jobSeq.current) return;             // 取消 / 关 tab / 重新发起
      // 取消返回 null。上面那次代际比较已经把这条路挡掉了（isCancelled 与它是同一个谓词），
      // 留着是为了 translateDoc 将来多一条返回 null 的路径时不至于把 job 永久挂在那儿。
      if (doc === null) { usePdfTranslationStore.getState().setJob(tab.id, null); return; }
      // 提交点：进入 finalize 之后浮层的取消按钮禁用，因为 jobSeq 挡不住一次已经发出的
      // save——把提交点画在「发出 save 之前」才守得住「取消不留痕」（spec §9.3）。
      // 这一档的三个数字**都得是真的**，别为了「有个东西可填」编一组：`failed: 0` 会让「N 页
      // 失败」在保存那一刻凭空消失（浮层上那句「· N 页失败」跟着灭掉），
      // `done: 0 / total: 1` 会让进度条从 100% 跳回 0% 再消失。页已经全部翻完了，保存阶段的
      // 诚实读数就是「translated / translated」＋这一趟真实的失败页数。
      usePdfTranslationStore.getState().setJob(
        tab.id, { phase: 'finalize', done: translated, total: translated, failed: lastFailed },
      );
      await window.kydog.invoke('pdf.translation.save', { pdfPath: tab.path, doc });
    } catch (err) {
      if (my !== jobSeq.current) return;
      usePdfTranslationStore.getState().setJob(tab.id, null);
      // 已经在对照中发起的重译失败了：那份旧 doc 还在 store 里、右格能正常合成，不该把用户
      // 一并踢出对照（wasDualRef，见上面的注释）。
      if (!wasDualRef.current) usePdfTranslationStore.getState().setDual(tab.id, false);
      setTranslateError((err as Error).message);
      return;
    }
    if (my !== jobSeq.current) return;
    // **先清 job、再 loadTranslation**：清了 job 那道闸才放行，而此刻边车已经在盘上，
    // setLoaded 拿到的是非空且摘要匹配的 doc，不会把 dual 收掉（spec §9.2）。
    usePdfTranslationStore.getState().setJob(tab.id, null);
    // 不必等这次加载、也没有任何要在它之后写的东西：这一趟失败了哪几页已经随边车落了盘，
    // 加载回来的 doc 自己带着答案（doc.failedPages）。
    void loadTranslation();
  }, [tab.id, tab.path, sizes, bytes, sha, numPages, enterDualFitWidth, loadTranslation]);

  // 取消：自增代际（在途的续体从此写不进 store）、清 job；只有**这趟作业开始前不在对照中**才收
  // dual（wasDualRef，见 startTranslation 头上的注释）——已经在对照中发起的重译被取消，不该把
  // 用户一并踢出这个本来完好的对照视图。收 dual 会让下面那个 effect 把缩放还原回进对照前——
  // 与显式退出、自动退出共用同一条还原路径。**什么都不写盘**：save 要么还没发出，要么已经进了
  // finalize 而那时取消按钮是禁用的（spec §9.3）。
  const cancelTranslation = useCallback(() => {
    jobSeq.current += 1;
    const st = usePdfTranslationStore.getState();
    st.setJob(tab.id, null);
    if (!wasDualRef.current) st.setDual(tab.id, false);
  }, [tab.id]);

  // 「全部重译」键（PdfToolbar，只在 active 态渲染）：直接跑一次新的流水线，与 onToggleDual 的
  // none/invalid/mismatch 分支调的是同一个 startTranslation——区别只在于调用这一刻 dual 已经
  // 是 true（wasDualRef 会记住这一点）。这里没有另判一次 canPressTranslate：守卫现在下沉在
  // startTranslation 自己开头（Minor #4，见其注释），这个调用点因此天然安全，不必在这里重复。
  //
  // 这颗键只在 active 态渲染（判据见 PdfToolbar），也就是说点下去这一刻磁盘上必然有一份可用的
  // 译文边车正在被覆盖——不像 none 态是从无到有。破坏性操作先走统一的 confirm()（CLAUDE.md
  // 的约定：不引入危险色，覆盖写靠对话框而不是颜色警示），不必再判一次态，判据已经在「这个按钮
  // 会不会被渲染出来」里体现过了。
  const onRetranslate = useCallback(async () => {
    const ok = await confirm({
      title: '全部重译，覆盖当前译文？',
      message: '会覆盖当前译文正文（术语表保留），且不可撤销。',
      confirmLabel: '全部重译',
    });
    if (!ok) return;
    void startTranslation();
  }, [startTranslation]);

  // 「重译本页」：只翻读数那一页，覆盖它的块——覆盖写，走 confirm()（同全部重译）。
  const onRetranslatePage = useCallback(async () => {
    const pageNo = currentPage;
    const ok = await confirm({
      title: `重译第 ${pageNo} 页，覆盖这一页的译文？`,
      message: '只覆盖这一页的译文正文（术语表保留），且不可撤销。',
      confirmLabel: '重译本页',
    });
    if (!ok) return;
    void startTranslation({ pages: [pageNo] });
  }, [currentPage, startTranslation]);

  // 「重试失败页」：只翻边车里记的失败页。它们没有块，什么都不覆盖，不弹确认。
  // failedPages 是边车文件里的数据，可能是 agent 手写的——pages 的「升序、不重复」这条前置
  // 条件（translateDoc 合并逻辑依赖它）没有别的地方守，这里去重排序一遍再交出去。
  const onRetryFailed = useCallback(() => {
    const failed = usePdfTranslationStore.getState().buckets[tab.id]?.doc?.failedPages;
    if (!failed?.length) return;
    void startTranslation({ pages: [...new Set(failed)].sort((a, b) => a - b) });
  }, [tab.id, startTranslation]);

  // 「删除译文」：删边车 → 走现有的 loadTranslation 重探，ENOENT → setLoaded(null) 收掉 dual →
  // 还原缩放那个 effect 把缩放还回去。**不新加任何状态**（spec 2026-09-06 §5，不变量 #9）。
  const onDeleteTranslation = useCallback(async () => {
    const ok = await confirm({
      title: '删除译文？',
      message: '会删除磁盘上的译文文件（含术语表），退出对照回到原文，且不可撤销。',
      confirmLabel: '删除',
    });
    if (!ok) return;
    try {
      await window.kydog.invoke('pdf.translation.delete', { pdfPath: tab.path });
    } catch (err) {
      setTranslateError((err as Error).message);
      return;
    }
    setTranslateError(null);
    void loadTranslation();
  }, [tab.path, loadTranslation]);

  // 翻译键 / `L` 的动作分派（spec §1、§10）。两个调用点：工具栏翻译键的 onClick（点击时已经被
  // disabled 挡过一轮，见 PdfToolbar），annotationKeys.ts 的 L 分支（键盘不经过 IconButton 的
  // disabled，靠它自己先调 canPressTranslate 判过一轮）。这里再判一次 canPressTranslate 不是
  // 重复的第三份条件——调的是同一个纯函数（pdfTranslationStore.ts），只是让这个真正做状态改动
  // 的函数本身对「不该进」的调用也是安全的，不必信任每个调用点都已经判过。
  //
  // 二期起这个键有两种动作：已经有可用译文就进 / 出对照，没有（或边车有误 / 摘要对不上）就跑
  // 翻译流水线。分派按 translateUiState 的返回值，不在这里另写一遍条件。
  //
  // **退出这条路径不在这里还原缩放**：还原只有下面那个 effect 一条路（显式退出与 setLoaded 的
  // 自动退出共用），这里只负责把 dual 收掉。`dual === false && prevScale !== null` 因此是一个
  // 「还没被消费的还原请求」瞬态，谁把 dual 收掉都行，还原都会发生。
  const onToggleDual = useCallback(() => {
    const st = usePdfTranslationStore.getState();
    const b = st.buckets[tab.id];
    if (!b || !sizes) return;
    if (!canPressTranslate(b)) return; // 与工具栏同一份判据（pending/translating 才会被这里挡住）
    const state = translateUiState(b);
    // none / invalid / mismatch：动作是「跑流水线」。只有 invalid（边车存在但结构有误，
    // loadTranslation 的 catch 分支 setLoadError）与 mismatch（边车存在且合法，只是摘要与当前
    // PDF 对不上，checkVersion 判的）这两态会**覆盖磁盘上一份已经存在的边车**——判据是协议层
    // 事实本身（b.loadError / b.doc 与 b.version，见 translateUiState），不是另猜一套。none 是
    // pdf.translation.load 对 ENOENT 返回的空结果，磁盘上压根没有文件，从无到有不是破坏性操作，
    // 不加确认——否则最常见的「第一次翻译」路径会平白多一步。
    //
    // **清 translateError 排在 confirm() 之后**：确认框弹出到用户按下按钮之间什么都没发生，
    // 取消更是「这次动作根本没开始」——此刻抹掉一条仍然成立的提示（典型如「没配模型」）等于
    // 把界面上唯一的线索按没了。确认之后再清（startTranslation 开头也会清一遍，冗余但无害）。
    if (state === 'invalid' || state === 'mismatch') {
      void (async () => {
        const ok = await confirm({
          title: '重新翻译，覆盖现有译文？',
          message: state === 'invalid'
            ? '磁盘上的译文文件已经损坏，重新翻译会整份覆盖掉它，且不可撤销。'
            : '磁盘上已有一份译文，但和当前 PDF 对不上；重新翻译会覆盖它（术语表保留，译文正文不保留），且不可撤销。',
          confirmLabel: '重新翻译',
        });
        if (!ok) return;
        setTranslateError(null);
        void startTranslation();
      })();
      return;
    }
    // 下面三支都是「按下去当场就发生」的动作，旧错误对这一刻已经不成立，入口清掉
    // （清除时机见 translateError 声明处的注释，理由 2）：'none' 那支会走 startTranslation
    // 再清一遍（冗余但无害），'active'/'ready' 那两支原本没有别的清除点。
    setTranslateError(null);
    if (state === 'active') { st.setDual(tab.id, false); return; }
    if (state === 'ready') { enterDualFitWidth(); return; }
    void startTranslation();           // none：从无到有，不是破坏性操作
  }, [tab.id, sizes, enterDualFitWidth, startTranslation]);

  // 退出对照后把缩放还原回进入前——**唯一**的还原路径，显式退出（上面的 onToggleDual）与自动
  // 退出（pdfTranslationStore 的 setLoaded 在 doc 变 null / version 变 mismatch 时收 dual）
  // 都走它。原先只有显式退出那条路会还原，自动退出把用户丢在双栏 fit-width 的小缩放上。
  //
  // 判据是 store 里那个「已经不在对照中、但还留着一份进入前的缩放」的瞬态：dual 收掉的那一刻
  // 它成立，这里消费掉（clearPrevScale）并还原，此后 `dual === false && prevScale !== null`
  // 就不再稳定存在。谁把 dual 收掉都行，还原都会发生。
  //
  // passive useEffect 就够，**不需要** useLayoutEffect。担心的是这个：收掉 dual 的那次 commit
  // 已经把版面画成「单栏 + 还没还原的 fit-width 小缩放」，还原若晚一个任务，中间就隔着一次
  // 渲染机会，用户会看到一帧小画面再跳回去。它的前提是 passive effect 会被排进 Scheduler 的
  // 宏任务——在这条路径上不成立，两条协议层事实：
  //   1. dual / prevScale 都出自 zustand，读它们走 useSyncExternalStore，而 React 的
  //      forceStoreRerender **无条件**用 SyncLane（react-dom-client.development.js 里的
  //      `scheduleUpdateOnFiber(root, fiber, 2)`），与触发它的是不是 discrete 事件无关——按 L
  //      与自动退出（`pdf.translation.load` 续体里的 setLoaded）走的是同一条。
  //   2. commit 末尾对 SyncLane 那批更新**同步**冲刷 passive effect（同文件的
  //      `0 !== (pendingEffectsLanes & 3) && flushPendingEffects()`）。
  // 收 dual 与还原因此恒在同一个任务里跑完，中间没有渲染机会可插。e2e「自动退出也还原缩放，
  // 且与收掉 dual 落在同一次 commit 里」把这条同任务性质钉住了：真退化成晚一个任务（改用
  // setTimeout / rAF 还原，或还原不再由这个 effect 负责），那条会红。
  const pendingRestore = usePdfTranslationStore((s) => s.buckets[tab.id]?.prevScale ?? null);
  useEffect(() => {
    if (dual || pendingRestore == null) return;
    usePdfTranslationStore.getState().clearPrevScale(tab.id);
    requestScale(pendingRestore, false);
  }, [dual, pendingRestore, tab.id, requestScale]);

  // 重读滚动几何 → 重算窗口与页码读数。两件事都从 layout.tops 纯算，一次 DOM 量取都不做
  // （scrollTop / clientHeight 是滚动容器自己的两个数，不是逐页的 getBoundingClientRect）。
  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    contentTop.current = el.scrollTop / visualScaleRef.current;
    clientHeight.current = el.clientHeight;
    if (!sizes || !layout) { setWin(EMPTY_WINDOW); return; }
    const top = contentTop.current * visualScale;
    setCurrentPage(mostVisiblePage(layout.tops, sizes, visualScale, top, top + clientHeight.current));
    const next = computeWindow({
      sizes, tops: layout.tops, scrollTop: top, clientHeight: clientHeight.current,
      visualScale, dpr: window.devicePixelRatio, editingPage,
    });
    setWin((prev) => (sameWindow(prev, next) ? prev : next));
  }, [sizes, layout, visualScale, editingPage]);
  const recomputeRef = useRef(recompute);
  recomputeRef.current = recompute;
  // 窗口的其余输入（页尺寸、缩放、钉住的编辑页）变了也要重算一次——它们不来自滚动，没有
  // scroll 事件可搭。deps 就是 recompute 自己：它的引用恰好在这些输入变化时才换。
  useEffect(() => { recompute(); }, [recompute]);

  // 窗口变化后扫一遍：把「引用已归零、当时还在窗口内被放过一马」的页重新判定一次
  // （pageLifecycle.ts 的 sweep）。窗口挪走了才真的清，还在窗口内就继续留着。
  useEffect(() => { lifecycle.current.sweep((p) => win.pages.has(p)); }, [win]);

  // 测试探针：把已清理的页数挂到 window 上（Task 8 的 e2e 用例读它）。纯计数，挂 window 而不
  // 进 store——进 store 会让每次清理都触发一轮组件重渲染，为一个测试探针不值得。
  useEffect(() => {
    (window as unknown as { __kydogCleanedPages?: number }).__kydogCleanedPages = lifecycle.current.cleanedCount();
  }, [win]);

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
  //
  // 旧文档的页**不会**走 cleanup()：`pageProxies.current = {}` 是同步的，早于旧 lifecycle
  // 已经排在 microtask 里的那些清理；它们跑到时 getProxy 拿到的是新的空表，什么都清不了
  // （也因此不再虚增 cleanedCount，见 pageLifecycle 的 run）。真正把旧文档的解码缓存还回去的
  // 是 react-pdf 内部 `loadDocument` 这个 effect 的 cleanup——它以 `source`（随 file/fileUrl
  // 派生）为依赖，fileUrl 变了就先跑 cleanup 再重建，cleanup 里对旧 loadingTask 调用
  // `destroy()`（node_modules/react-pdf/dist/esm/Document.js:257）。不是 `<Document>` 元素被
  // 销毁重建——它的元素类型没变，React 不会拆整棵子树。这里换掉 lifecycle 是为了别把
  // 上一份文档的引用计数和待清理队列带进新文档，不是为了清理旧文档。
  useEffect(() => {
    prefetchToken.current += 1;
    setSizes(null);
    pageProxies.current = {};
    pdfRef.current = null;      // 新文档的 onLoadSuccess 会重新填；在那之前别拿上一份文档的页

    linesCache.current = {};
    lifecycle.current = createPageLifecycle(
      (n) => pageProxies.current[n] as unknown as Cleanable | undefined,
    );
  }, [fileUrl]);

  // 缩放后按鼠标锚点回算滚动位置，使鼠标下的内容点保持不动（同 macOS 预览）。
  //
  // 快照与回写**同取事件所在的那一栏**（`a.el`，由 requestScale 一并记下），另一栏由滚动同步
  // 跟上。两个量必须同源：`scrollLeft + focal.x` 只有在两者出自同一个视口时才是那一栏里的内容
  // 坐标。**两栏的 scrollLeft 不是恒相等的**——窄栏横向滚到自己的上界之后宽栏还到不了那么远，
  // 从此差着两栏可视宽之差（spec §3.1「诚实的代价」，57 里有一条用例专门造出这个状态）。此时
  // 若拿右栏量的焦点配左栏的快照，鼠标下那一点会跳掉这个差值。纵向同理（两栏各有自己的占位
  // 横向滚动条时 clientHeight 差一条，maxScrollTop 跟着差）。
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    if (!a) return;
    const f = visualScale / a.prevScale;
    if (f === 1) return;
    a.el.scrollLeft = (a.sl + focal.current.x) * f - focal.current.x;
    a.el.scrollTop = (a.st + focal.current.y) * f - focal.current.y;
  }, [visualScale]);

  // 新层某一页渲染结束（成功或失败都计入）；**可见页**全部就绪即顶替（promoteReady）。
  // 不能再按 numPages 判定：虚拟化之后窗口外的页压根不挂载，那个数永远凑不齐，每次缩放都要
  // 卡满 PROMOTE_TIMEOUT 才顶替。也不按整个窗口判定：窗口里还有预取页，它们画完与否用户看不见，
  // 等它们只会让顶替更晚。
  const onPageSettled = useCallback((layerId: number, page: number) => {
    const cur = layersRef.current;
    const incoming = cur.length > 1 ? cur[cur.length - 1] : null;
    if (!incoming || incoming.id !== layerId) return; // 只统计后台新层
    if (progress.current.id !== layerId) progress.current = { id: layerId, done: new Set() };
    // 先无条件记下「这一页画完了」，再判条件——不能拿「此刻可不可见」过滤，那会把预取页的完成
    // 事实丢掉：预取页画完时不可见（直接 return、不记），用户随后滚一点让它进了视口，need 里
    // 有它、done 里没有，而它**已经画完、不会再有回调**（key 稳定、scale 未变，react-pdf 不重画），
    // 于是只能等 PROMOTE_TIMEOUT。记多了无害，判据是 need ⊆ done，不会提前顶替。
    progress.current.done.add(page);
    if (promoteReady(winRef.current.visible, progress.current.done)) promote('condition');
  }, [promote]);

  // 可见集变化之后也要重判一次：visible 收缩时剩下的页可能早已 settled，条件其实已经满足，
  // 但 promote 只在渲染回调里被调用——没有新回调就没人重新判定，同样只能等 PROMOTE_TIMEOUT。
  useEffect(() => {
    const incoming = layers.length > 1 ? layers[layers.length - 1] : null;
    if (!incoming || progress.current.id !== incoming.id) return;
    if (promoteReady(win.visible, progress.current.done)) promote('condition');
  }, [win.visible, layers, promote]);

  // 触摸板捏合缩放：Chromium 把捏合转成 ctrl+wheel。
  //
  // 监听挂在 **wrapper** 而不是左栏上（spec v8 §3.1）：在右栏上捏也要能缩。焦点因此相对
  // **事件所在的那一栏**算（closest('[data-pdf-pane]')；落在工具栏、Notice 上时退回左栏）。
  useEffect(() => {
    if (tab.status !== 'ready') return;
    const wrap = wrapperRef.current;
    const el = scrollRef.current;
    if (!wrap || !el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return; // 非捏合的滚轮 → 走默认滚动（连续翻页）
      e.preventDefault();
      const pane = ((e.target as Element).closest('[data-pdf-pane]') ?? el) as HTMLElement;
      const rect = pane.getBoundingClientRect();
      focal.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      // 焦点相对谁量的，锚点快照就取谁（requestScale 读这个 ref）。两个量同源，不依赖「两栏
      // scrollLeft 恒相等」——那条在窄栏滚到头之后就不成立了，见回算那个 useLayoutEffect。
      focalPane.current = pane;
      // 逐事件累积目标缩放（只动 ref，不惊动 React），逐帧才真正落地一次——落地与「排提交」
      // 都在 requestScale 里，见模块级 useVisualScale。
      //
      // `targetScale` 是**捏合手势的累积器，不是「当前缩放」**：两次 wheel 之间它领先
      // visualScale，rAF 落地时才对齐。useVisualScale 那句「requestScale 是唯一入口」说的是
      // visualScale 这一个 state，不覆盖这里对累积器的自增——读当前缩放请用 visualScaleRef。
      // 这里那次 MIN/MAX 夹取也不是 requestScale 里那次的重复：不夹的话，往一个方向连推几十个
      // wheel 事件会把累积器推到远离区间的地方，反向捏合要先「绕回来」才看得见变化。
      targetScale.current = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, targetScale.current * (1 - e.deltaY * ZOOM_SENSITIVITY)),
      );
      // 手势中：每帧更新一次 CSS zoom，瞬时无闪
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          requestScale(targetScale.current, true);
        });
      }
    };
    wrap.addEventListener('wheel', onWheel, { passive: false });
    // 窗口重算只搭左栏的滚动事件：右栏的滚动会被同步写回左栏，左栏照样发一次 scroll。
    el.addEventListener('scroll', scheduleRecompute, { passive: true });
    return () => {
      wrap.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', scheduleRecompute);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      // commitTimer / promoteTimer 的清理不在这里——见 scheduleCommit 下面那个不设门的 effect。
    };
  }, [tab.status, requestScale, scheduleRecompute]);

  /**
   * 两栏滚动同步（spec v8 §3.1）。回声锁与「同值不写」在 scrollSync.ts，这里只负责把两个真
   * DOM 元素接上去。
   *
   * 1:1 直接互写（而不是按比例换算）成立的前提是**两栏内容尺寸逐字段相同**——同一份 sizes /
   * layout / layer.scale / PAGE_GAP / PAGE_PAD，行宽都是 `size.w * layer.scale`（见下面的
   * renderLayers）。不等宽时 `scrollLeft` 原样相等，两栏的**内容左边缘**因此对齐；宽栏往右
   * 多露一截、窄栏被裁，这正是把它拖宽的目的。
   *
   * `sync(a, b)` 先跑一次：右栏是刚挂上的，scrollTop 为 0，而左栏可能早就滚在半路。
   */
  useEffect(() => {
    const a = scrollRef.current;
    const b = rightRef.current;
    if (!a || !b) return;
    const sync = createScrollSync((cb) => requestAnimationFrame(cb));
    const onA = () => sync(a, b);
    const onB = () => sync(b, a);
    a.addEventListener('scroll', onA, { passive: true });
    b.addEventListener('scroll', onB, { passive: true });
    sync(a, b);
    return () => {
      a.removeEventListener('scroll', onA);
      b.removeEventListener('scroll', onB);
    };
  }, [dual, tab.status]);

  /**
   * 拖分隔线（spec v8 §3.1）。PaneDivider 只交出 clientX，比例的换算连同两侧的 MIN_PANE_PX
   * 下限都在 clampSplit 里。
   *
   * 拖完**不重新 fit-width**：缩放是用户捏出来的，拖栏也是用户拖的，替他改掉其中一个是自作主张。
   */
  const onDividerDrag = useCallback((clientX: number) => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    setDragging(true);
    const r = wrap.getBoundingClientRect();
    setSplit(clampSplit(clientX, r.left, r.width));
  }, []);

  // 视口尺寸变了（拖窗、开合侧栏）窗口也要重算——这时没有滚动事件，滚动帧那条路不会跑。
  //
  // 待实测（浏览器行为假设，不算关键决策；pageWindow.ts 空间上界那段注释里是同一个假设，两处
  // 都待验，判据相同）：tab 被 display:none 藏起来时 Chromium 同样会触发这个 ResizeObserver
  // 回调、且 clientHeight 读数为 0。仓库里目前没有覆盖它的用例——e2e/ 下没有「开两个 file tab、
  // 切走再切回同一个 PDF tab」这条路径（HTML 那边切 tab 的焦点由 HtmlFileTab.test.tsx 守，
  // 不走真布局，参考不了）。判据：开两个 file tab、切到另一个 tab 让这个 PDF tab
  // 变成 display:none，隐藏期间对它的滚动容器读 el.clientHeight 应为 0，且能观察到
  // ResizeObserver 回调确实又跑了一次。若假设成立，那是「没有视口」而不是「视口很小」，
  // computeWindow 的空间上界会让窗口退到只剩必保页；不成立（回调不触发，或 clientHeight 不是
  // 0）则这段退化逻辑没有实际生效，需要另外显式监听 tab 的可见性切换。
  //
  // 同时观察 **wrapper**，把它的 clientWidth 存进 state 供 paneWidths 用。不能只观察左栏：
  // 对照时左栏的宽是一个由 wrapperW 算出来的**固定像素**，wrapper 变宽只会让右栏（flex: 1）
  // 跟着变宽，左栏纹丝不动、RO 不触发，wrapperW 就永远停在旧值，左栏再也不随窗口走了。
  // 回写自己观察的量不会打转：wrapperW 变 → 左栏宽变 → RO 再触发 → setWrapperW 拿到同一个数，
  // React 的 Object.is 直接 bail out。
  useEffect(() => {
    const el = scrollRef.current;
    const wrap = wrapperRef.current;
    if (!el || !wrap) return;
    const ro = new ResizeObserver(() => {
      setWrapperW(wrap.clientWidth);
      recomputeRef.current();
    });
    ro.observe(el);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [tab.status]);

  const [scrollTick, setScrollTick] = useState(0);
  const selectedId = usePdfAnnotationStore((s) => s.buckets[tab.id]?.selectedId ?? null);
  const doc = usePdfAnnotationStore((s) => s.buckets[tab.id]?.doc ?? null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  // 浮条锚点：选中项元素相对外层容器的框；滚动、缩放、doc 变化都重算。
  // 两栏都带 data-pdf-layer，但标注只有左栏有，这个选择器不会误命中右栏。
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

  /**
   * 一栏的内容：双缓冲层 → 页行 → 格。两栏各调一次，**逐字段同源**——同一份 layers（连
   * `layer.scale` 一起）、同一份 sizes / layout、同一个 PAGE_GAP / PAGE_PAD，行宽都是
   * `size.w * layer.scale`。这是 1:1 滚动映射成立的前提（spec v8 §3.1）：两栏内容尺寸只要有
   * 一处不同，`scrollTop` 相等就不再意味着两边看到的是同一处。
   *
   * 是一个**渲染函数、不是组件**：写成组件的话每次渲染都是新的函数引用，React 会当成换了组件
   * 类型，整棵子树 unmount→mount（同 LeftCell 头上那条理由）。
   *
   * `data-pdf-page` / `data-pdf-mounted` / `data-pdf-layer` 两栏都带，e2e 靠外面那层
   * `[data-pdf-pane]` 区分是哪一栏。
   */
  const renderLayers = (pane: 'left' | 'right') => (
    /* relative 容器：清晰层（idx 0）在流内定版面，后台新层（idx 1）绝对叠在其下方 */
    <div style={{ position: 'relative' }}>
      {layers.map((layer, idx) => (
        <div
          key={layer.id}
          data-pdf-layer={idx === 0 ? 'stable' : 'incoming'}
          // 只挂在 stable 层上：这个值是「最近一次顶替走的是哪条路」，incoming 层还没被
          // 顶替过，不该有这个属性（e2e 用它区分 promoteReady 条件顶替与 PROMOTE_TIMEOUT
          // 兜底，见 PromoteReason 的注释）。
          data-pdf-promote-reason={idx === 0 ? (promoteReason ?? undefined) : undefined}
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
                只有窗口内的行才挂真正的格子（左栏是 canvas 与栅格化开销，右栏是合成）。
                行宽恒是**一页**宽——两格分居两栏之后，同页两格的顶对齐不再靠同一个 flex 行，
                而靠两栏行几何逐字段相同 + 滚动同步（spec v8 §3.1 写明了这份代价）。 */}
            {sizes && layout && sizes.map((size, k) => {
              const n = k + 1;
              const mounted = win.pages.has(n);
              return (
                <div
                  key={n}
                  data-pdf-page={n}
                  data-pdf-mounted={mounted ? '1' : undefined}
                  style={{
                    height: size.h * layer.scale,
                    width: size.w * layer.scale,
                    flexShrink: 0,
                  }}
                >
                  {mounted && (pane === 'left' ? (
                    <LeftCell
                      n={n} layerId={layer.id} lifecycle={lifecycle.current} size={size}
                      layerScale={layer.scale} registry={registry}
                      onPageLoad={(p) => { pageProxies.current[n] = p; }}
                      onSettled={() => onPageSettled(layer.id, n)}
                      annotations={idx === 0 ? (
                        <PdfAnnotationLayer
                          tabId={tab.id} page={n} pageWidth={size.w} pageHeight={size.h}
                          layerScale={layer.scale} ensureLines={ensureLines}
                        />
                      ) : null}
                    />
                  ) : (
                    <RightCell
                      n={n} layerId={layer.id} size={size} layerScale={layer.scale}
                      translating={job !== null} blocks={blocksByPage.get(n) ?? NO_BLOCKS}
                      docKey={tab.id} registry={registry}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );

  // 对照时左栏宽给的是像素（paneWidths），非对照时整条铺满——那时没有第二栏可分。
  const panes = paneWidths(wrapperW, split);
  return (
    <div
      ref={wrapperRef}
      tabIndex={0}
      style={{
        position: 'relative', height: '100%', outline: 'none', display: 'flex',
        // 拖分隔线时横扫会把右栏的译文块整片选中，拖完还留着高亮
        userSelect: dragging ? 'none' : undefined,
      }}
      onKeyDown={(e) => { if (handleAnnotationKey(e, tab.id, onToggleDual)) e.preventDefault(); }}
      onPointerDownCapture={(e) => {
        const t = e.target as Element;
        if (!t.closest('textarea, button')) wrapperRef.current?.focus();
      }}
    >
      <div
        style={{
          position: 'relative',
          flex: dual ? `0 0 ${panes.left}px` : '1 1 auto',
          minWidth: 0, height: '100%',
        }}
      >
        <div
          ref={scrollRef}
          data-testid={`pdf-scroll-${tab.id}`}
          data-pdf-pane="left"
          className="ky-scroll-overlay h-full w-full overflow-auto"
          style={{ background: 'var(--color-paper-deep)' }}
        >
          {fileUrl && (
            <Document
              file={fileUrl}
              loading={null}
              error={null}
              onLoadSuccess={(pdf) => {
                setNumPages(pdf.numPages);
                // 翻译要按页抽文本，而 pageProxies 未必每页都有（见 pdfRef 的注释）。
                pdfRef.current = { getPage: (n) => pdf.getPage(n) as unknown as Promise<PageProxyLike> };
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
              {renderLayers('left')}
            </Document>
          )}
        </div>
        <OverlayScrollbar targetRef={scrollRef} axis="y" testId="pdf-thumb-y-left" />
        <OverlayScrollbar targetRef={scrollRef} axis="x" testId="pdf-thumb-x-left" />
      </div>
      {dual && (
        <PaneDivider
          onDragTo={onDividerDrag}
          onDragEnd={() => setDragging(false)}
          onReset={() => setSplit(0.5)}   // 双击回正中：拖过之后一下子恢复等宽（Yee 2026-09-07）
        />
      )}
      {dual && (
        // 右栏与进度浮层的共同父层：浮层是滚动容器的**兄弟**、absolute 居中，放进滚动容器里
        // 会跟着内容滚走。右栏宽度让 flex 收（`flex: 1`）而不是也写死像素：分隔线与左栏都是
        // 确定的像素，剩下的正好是 paneWidths 里的 right，两者恒等，少一处四舍五入。
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <div
            ref={rightRef}
            data-testid={`pdf-right-scroll-${tab.id}`}
            data-pdf-pane="right"
            className="ky-scroll-overlay h-full overflow-auto"
            style={{ background: 'var(--color-paper-deep)' }}
          >
            {renderLayers('right')}
          </div>
          {/* 右栏不画拇指：两栏同步滚动，左栏那条正好落在两栏之间，右栏再来一条只是重复
              （Yee 2026-09-07 手测）。原生滚动条仍由 ky-scroll-overlay 藏掉，槽不占位。 */}
          {/* 进度浮层就在右栏矩形里居中（右栏此刻整片空白），工具栏 zIndex 5 仍压在它上面照常可用。 */}
          {job && <TranslationProgress job={job} onCancel={cancelTranslation} />}
        </div>
      )}
      <PdfAnnotationNotice tabId={tab.id} pdfPath={tab.path} translateError={translateError} />
      <PdfToolbar
        tabId={tab.id} pageLabel={`${currentPage} / ${numPages || 1}`} zoomPct={Math.round(visualScale * 100)}
        onToggleDual={onToggleDual} onRetranslate={onRetranslate}
        onRetranslatePage={onRetranslatePage} onRetryFailed={onRetryFailed} onDelete={onDeleteTranslation}
      />
      {anchor && <PdfSelectionBar tabId={tab.id} anchor={anchor} />}
    </div>
  );
}
