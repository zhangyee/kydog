import { create } from 'zustand';
import type { TranslatedDoc } from '../../../../shared/zhSidecar';

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
};

export function emptyTBucket(): TBucket {
  return { doc: null, loadError: null, version: 'unknown', dropped: 0, dual: false, prevScale: null };
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

/** 工具栏翻译键的四态（Task 8）：'none' 没有译文、'invalid' 边车结构有误、'mismatch' 摘要
 *  对不上、'ready' 可点、'active' 已在对照中。 */
export type TranslateUiState = 'none' | 'invalid' | 'mismatch' | 'ready' | 'active';

/**
 * 工具栏四态与 `L` 快捷键能不能进对照，是同一份判据——两处各判一次是最难查的那类 bug
 * （一处能进、另一处不能进）。收敛成这一个纯函数，两个消费方（PdfToolbar 的四态渲染、
 * annotationKeys.ts 的 L 分支）都调它，不各自重写一遍条件。
 *
 * 顺序很关键：`loadError` 时 `doc` 恒为 null（见下面 `setLoadError`），必须先判 `loadError`
 * 才能把「边车结构校验失败」（invalid）与「边车压根不存在」（none，`pdf.translation.load`
 * 返回空 doc）区分开——顺序反了的话，结构有误的边车会先被 `!doc` 挡住，永远走不到 invalid。
 */
export function translateUiState(b: TBucket | undefined): TranslateUiState {
  if (b?.loadError) return 'invalid';
  if (!b?.doc) return 'none';
  if (b.version === 'mismatch') return 'mismatch';
  return b.dual ? 'active' : 'ready';
}

/** 能不能按 L / 点工具栏键切换对照：四态里只有 ready、active 放行。 */
export function canToggleDual(b: TBucket | undefined): boolean {
  const s = translateUiState(b);
  return s === 'ready' || s === 'active';
}

type State = {
  buckets: Record<string, TBucket>;
  setLoaded: (tab: string, doc: TranslatedDoc | null, version: VersionState, dropped: number) => void;
  setLoadError: (tab: string, msg: string) => void;
  setDual: (tab: string, dual: boolean, prevScale?: number | null) => void;
  /** 消费掉那份待还原的缩放（见 TBucket.prevScale）。调用方负责真的去还原。 */
  clearPrevScale: (tab: string) => void;
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
  clearPrevScale: (tab) => set((s) => (
    s.buckets[tab] ? { buckets: { ...s.buckets, [tab]: { ...s.buckets[tab], prevScale: null } } } : s
  )),
  drop: (tab) => set((s) => {
    const next = { ...s.buckets };
    delete next[tab];
    return { buckets: next };
  }),
}));
