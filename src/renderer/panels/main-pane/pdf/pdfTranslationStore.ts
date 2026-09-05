import { create } from 'zustand';
import type { TranslatedDoc } from '../../../../shared/zhSidecar';
import type { JobProgress } from './translateDoc';

/** ok = 摘要对得上；mismatch = 对不上，禁用；unknown = 边车没写摘要，可用但提示。 */
export type VersionState = 'ok' | 'mismatch' | 'unknown';

export type TBucket = {
  doc: TranslatedDoc | null;
  loadError: string | null;
  version: VersionState;
  dropped: number;              // 几何越界被丢掉的块数
  dual: boolean;
  /**
   * 进入对照前的缩放，退出时用它还原；null = 没有待还原的缩放（进对照时行宽本来就放得下，
   * 压根没改过缩放）。
   *
   * 语义是「一份**还没被消费**的还原请求」，不是「进对照时的快照」：`dual === false &&
   * prevScale !== null` 是个瞬态——渲染层看见它就还原并 clearPrevScale（PdfFileTab 里那个
   * effect）。所以 setDual(tab, false) **不清**它：显式退出与 setLoaded 的自动退出因此共用
   * 同一条还原路径，不会出现「自动退出把用户丢在双栏的小缩放上」。
   */
  prevScale: number | null;
  /**
   * 这个 tab 的页尺寸预取完了没有（PdfFileTab 的 `sizes != null`）。
   *
   * 进对照要用第一页的宽度算 fit-width，sizes 还没到就只能什么都不做。原先它不进判据：
   * 大文档预取几百页时翻译键仍是 enabled，按下去静默无事发生、也没有任何反馈。放进 bucket 是
   * 为了让工具栏四态与 `L` 键共用同一份判据（translateUiState）——两处各判一次是最难查的
   * 那类 bug。
   */
  layoutReady: boolean;
  /**
   * 正在跑的翻译作业；null = 没有。进度是渲染层自己的 state，不跨进程推——编排就在渲染层
   * （翻译 spec §2.1）。
   *
   * phase 的第三档 `'finalize'` 是**提交点**：进入它的那一刻取消入口关闭。jobSeq 只挡得住
   * 「写渲染层的 store」，挡不住一次已经发出的 save——比过代际 → 发出 save → 用户在它返回前
   * 点取消 → 后续写入被挡掉，但边车已经落盘。把提交点画在「发出 save 之前」才守得住
   * 「取消不留痕」（spec §9.3）。
   */
  job: JobProgress | null;
};

export function emptyTBucket(): TBucket {
  return {
    doc: null, loadError: null, version: 'unknown', dropped: 0, dual: false, prevScale: null,
    layoutReady: false, job: null,
  };
}

/**
 * 译文与底图是不是同一版 PDF。
 *
 * 只看摘要。页数与 bbox 越界承担不了这件事：论文重新编译后页数通常不变、A4 尺寸不变、
 * 旧 bbox 也仍在页内，那些检查会全部通过（spec §5）。
 */
export function checkVersion(doc: TranslatedDoc, sha: string, bytes: number): VersionState {
  if (!doc.source) return 'unknown';
  const same = doc.source.sha256.toLowerCase() === sha.toLowerCase() && doc.source.bytes === bytes;
  return same ? 'ok' : 'mismatch';
}

/** 工具栏翻译键的七态：'translating' 正在跑翻译流水线、'pending' 页尺寸还没预取完、
 *  'invalid' 边车结构有误、'none' 没有译文、'mismatch' 摘要对不上、'ready' 可点进对照、
 *  'active' 已在对照中。二期起，没有译文 / 边车有误 / 摘要不匹配这三态从禁用变成可点——
 *  动作是「跑翻译流水线」，不再是「进对照」。 */
export type TranslateUiState = 'translating' | 'pending' | 'invalid' | 'none' | 'mismatch' | 'ready' | 'active';

/**
 * 工具栏的状态与 `L` 快捷键能不能动作，是同一份判据——两处各判一次是最难查的那类 bug
 * （一处能进、另一处不能进）。收敛成这一个纯函数，两个消费方（PdfToolbar 的状态渲染、
 * annotationKeys.ts 的 L 分支）都调它，不各自重写一遍条件。
 *
 * `loadError` 时 `doc` 恒为 null（见下面 `setLoadError`），必须先判 `loadError` 才能把
 * 「边车结构校验失败」（invalid）与「边车压根不存在」（none，`pdf.translation.load` 返回
 * 空 doc）区分开——顺序反了的话，结构有误的边车会先被 `!doc` 挡住，永远走不到 invalid。
 *
 * **`pending` 的排序理由在二期反过来了，别照一期的注释挪回去**：一期把 `pending`（页尺寸还没
 * 预取完）排在 invalid / none / mismatch **之后**，理由是「边车压根没有的时候说『正在准备
 * 页面』是误导，那三条与页尺寸预取到哪儿了无关」。二期那三条从禁用变成可点，动作是「跑翻译
 * 流水线」，而跑流水线要先进对照、进对照要用第一页宽度算 fit-width——它们**变得与页尺寸有关
 * 了**。所以 `pending` 必须排到它们前面。
 *
 * `translating` 排第一：翻译期间 `dual` 恒为 true（进度显示借用双栏布局），不先判它就会被
 * 后面的 `b.dual` 分支误判成 active。
 */
export function translateUiState(b: TBucket | undefined): TranslateUiState {
  if (b?.job) return 'translating';
  if (!b?.layoutReady) return 'pending';
  if (b.loadError) return 'invalid';
  if (!b.doc) return 'none';
  if (b.version === 'mismatch') return 'mismatch';
  if (b.dual) return 'active';
  return 'ready';
}

/** 能不能按 L / 点工具栏键：七态里只有 pending 与 translating 不放行——其余五态（含二期新放
 *  行的 none/invalid/mismatch）都有对应动作可做（跑流水线或进/出对照）。 */
export function canPressTranslate(b: TBucket | undefined): boolean {
  const s = translateUiState(b);
  return s !== 'pending' && s !== 'translating';
}

type State = {
  buckets: Record<string, TBucket>;
  setLoaded: (tab: string, doc: TranslatedDoc | null, version: VersionState, dropped: number) => void;
  setLoadError: (tab: string, msg: string) => void;
  setDual: (tab: string, dual: boolean, prevScale?: number | null) => void;
  /** 页尺寸预取完没有（见 TBucket.layoutReady）。写入方是 PdfFileTab 里跟着 sizes 走的那个 effect。 */
  setLayoutReady: (tab: string, ready: boolean) => void;
  /** 消费掉那份待还原的缩放（见 TBucket.prevScale）。调用方负责真的去还原。 */
  clearPrevScale: (tab: string) => void;
  /** 写入 / 清空当前作业进度（见 TBucket.job）。写入方是 translateDoc 的 onProgress 回调。 */
  setJob: (tab: string, job: JobProgress | null) => void;
  drop: (tab: string) => void;
};

export const usePdfTranslationStore = create<State>((set) => ({
  buckets: {},
  // dual 只在 version 仍是 ok 且 doc 非空时保持——mismatch（focus 重探撞见新版 PDF）或边车被删
  // 都会让右格继续拿旧块盖旧图，必须跟 setLoadError 一样把 dual 收掉（spec §12「正在对照中
  // 且边车变了 → 重新加载」）。version 仍是 ok 时原样保留 s.buckets[tab].dual，不能无条件置
  // false：这个 setLoaded 每次 focus 重探、sizes 到位重跑几何过滤都会调用一次，无条件置 false
  // 会把用户每次切窗口都踢出对照。
  setLoaded: (tab, doc, version, dropped) => set((s) => {
    const prev = s.buckets[tab] ?? emptyTBucket();
    const dual = doc === null || version === 'mismatch' ? false : prev.dual;
    return { buckets: { ...s.buckets, [tab]: { ...prev, doc, version, dropped, loadError: null, dual } } };
  }),
  setLoadError: (tab, msg) => set((s) => ({
    buckets: { ...s.buckets, [tab]: { ...(s.buckets[tab] ?? emptyTBucket()), doc: null, loadError: msg, dual: false } },
  })),
  // 进对照：prevScale 记下进入前的缩放（行宽本来就放得下则显式传 null，表示没什么要还原的）。
  // 出对照：**原样留着** prevScale——它此刻的含义是「一份还没被消费的还原请求」，由渲染层
  // 消费（见 TBucket.prevScale 的注释）。setLoaded 那条自动退出因此和显式退出走同一条还原路径。
  setDual: (tab, dual, prevScale = null) => set((s) => {
    const prev = s.buckets[tab] ?? emptyTBucket();
    return { buckets: { ...s.buckets, [tab]: { ...prev, dual, prevScale: dual ? prevScale : prev.prevScale } } };
  }),
  setLayoutReady: (tab, ready) => set((s) => {
    const prev = s.buckets[tab] ?? emptyTBucket();
    if (prev.layoutReady === ready) return s;   // 同值不建新对象，免得每次渲染都惊动订阅方
    return { buckets: { ...s.buckets, [tab]: { ...prev, layoutReady: ready } } };
  }),
  clearPrevScale: (tab) => set((s) => (
    s.buckets[tab] ? { buckets: { ...s.buckets, [tab]: { ...s.buckets[tab], prevScale: null } } } : s
  )),
  setJob: (tab, job) => set((s) => ({
    buckets: { ...s.buckets, [tab]: { ...(s.buckets[tab] ?? emptyTBucket()), job } },
  })),
  drop: (tab) => set((s) => {
    const next = { ...s.buckets };
    delete next[tab];
    return { buckets: next };
  }),
}));

// 测试探针：当前还挂着几个译文桶。同 PdfFileTab 的 __kydogCleanedPages，纯计数、不进 state，
// 只是让「关 tab 之后在途的那趟加载有没有把桶重建回来」这件事从组件外部（e2e）读得到——
// 组件已经卸载，那条路径不再有任何 DOM 痕迹，除此之外无从观察。
usePdfTranslationStore.subscribe((s) => {
  (globalThis as { __kydogTranslationBuckets?: number }).__kydogTranslationBuckets = Object.keys(s.buckets).length;
});
