import { create } from 'zustand';
import type {
  Highlight, HighlightColor, Level, Note, NoteColor, PdfAnnotation, PdfAnnotationsFile,
} from '../../../../shared/pdfSidecar';

export type Tool = 'select' | 'highlight' | 'note';

export type Bucket = {
  doc: PdfAnnotationsFile | null;   // null = 尚未加载
  loadError: string | null;         // 有值 = 边车坏了，工具置灰、永不保存
  saveError: string | null;
  tool: Tool;
  // 参数卡片是否展开。选工具时自动展开，第一次在页面上落笔就收起（用户反馈 3）：
  // 卡片只在「刚选了工具、还没开始画」这段时间有用，之后它只是挡着正文。
  cardOpen: boolean;
  hl: { color: HighlightColor; width: Level };
  note: { color: NoteColor; size: Level };
  selectedId: string | null;
  undo: PdfAnnotationsFile[];       // 整份快照，spec §3
  redo: PdfAnnotationsFile[];
};

const UNDO_LIMIT = 100;

export function emptyBucket(): Bucket {
  return {
    doc: null, loadError: null, saveError: null, tool: 'select', cardOpen: false,
    hl: { color: 'amber', width: 2 }, note: { color: 'ink', size: 2 },
    selectedId: null, undo: [], redo: [],
  };
}

type State = {
  buckets: Record<string, Bucket>;
  setLoaded: (tab: string, doc: PdfAnnotationsFile) => void;
  setLoadError: (tab: string, msg: string) => void;
  setSaveError: (tab: string, msg: string | null) => void;
  drop: (tab: string) => void;
  setTool: (tab: string, tool: Tool) => void;
  closeCard: (tab: string) => void;
  setHlParams: (tab: string, p: Partial<Bucket['hl']>) => void;
  setNoteParams: (tab: string, p: Partial<Bucket['note']>) => void;
  addHighlight: (tab: string, a: Highlight) => void;
  addNote: (tab: string, n: Note) => void;
  discardNote: (tab: string, id: string) => void;
  commitNoteText: (tab: string, id: string, text: string) => void;
  moveNote: (tab: string, id: string, x: number, y: number) => void;
  restyle: (tab: string, id: string, patch: { color?: HighlightColor | NoteColor; level?: Level }) => void;
  remove: (tab: string, id: string) => void;
  select: (tab: string, id: string | null) => void;
  undo: (tab: string) => void;
  redo: (tab: string) => void;
};

const withAnn = (doc: PdfAnnotationsFile, id: string, fn: (a: PdfAnnotation) => PdfAnnotation): PdfAnnotationsFile =>
  ({ ...doc, annotations: doc.annotations.map((a) => (a.id === id ? fn(a) : a)) });
const without = (doc: PdfAnnotationsFile, id: string): PdfAnnotationsFile =>
  ({ ...doc, annotations: doc.annotations.filter((a) => a.id !== id) });

export const usePdfAnnotationStore = create<State>((set, get) => {
  // 桶不存在时按空桶建——但前提是这次改动确实有东西要写。像 addHighlight 这类改 doc 的动作，
  // 对着一个 doc: null 的空桶只会算出空 patch（{}）；如果这时还是把桶建出来，就会把 tab 已经
  // 关闭之后迟到的一次 addHighlight 变成一个凭空长出来的 doc: null 桶（item 6）。
  // setLoaded / setLoadError / setTool / setHlParams / setNoteParams / select 这些总能算出非空
  // patch 的动作不受影响，照常建桶。
  const patch = (tab: string, fn: (b: Bucket) => Partial<Bucket>) =>
    set((s) => {
      const existing = s.buckets[tab];
      const b = existing ?? emptyBucket();
      const p = fn(b);
      if (!existing && Object.keys(p).length === 0) return {};
      return { buckets: { ...s.buckets, [tab]: { ...b, ...p } } };
    });
  // 桶不存在就什么都不做（关 tab 之后迟到的保存结果不该把桶造回来）
  const patchExisting = (tab: string, fn: (b: Bucket) => Partial<Bucket>) =>
    set((s) => {
      const b = s.buckets[tab];
      if (!b) return {};
      return { buckets: { ...s.buckets, [tab]: { ...b, ...fn(b) } } };
    });
  // 改 doc 的统一入口：先压快照（默认压当前 doc，可指定），清 redo，再改
  const edit = (
    tab: string,
    next: (doc: PdfAnnotationsFile) => PdfAnnotationsFile,
    snapshot: (doc: PdfAnnotationsFile) => PdfAnnotationsFile = (d) => d,
  ) => patch(tab, (b) => {
    if (!b.doc || b.loadError) return {};
    return { doc: next(b.doc), undo: [...b.undo, snapshot(b.doc)].slice(-UNDO_LIMIT), redo: [] };
  });

  return {
    buckets: {},
    setLoaded: (tab, doc) => patch(tab, () => ({ doc, loadError: null })),
    setLoadError: (tab, msg) => patch(tab, () => ({ loadError: msg })),
    setSaveError: (tab, msg) => patchExisting(tab, () => ({ saveError: msg })),
    drop: (tab) => set((s) => {
      const rest = { ...s.buckets };
      delete rest[tab];
      return { buckets: rest };
    }),
    // 点工具键（含点已激活的那个）都重新展开卡片：改参数就是这么找回来的
    setTool: (tab, tool) => patch(tab, () => ({ tool, selectedId: null, cardOpen: tool !== 'select' })),
    closeCard: (tab) => patchExisting(tab, () => ({ cardOpen: false })),
    setHlParams: (tab, p) => patch(tab, (b) => ({ hl: { ...b.hl, ...p } })),
    setNoteParams: (tab, p) => patch(tab, (b) => ({ note: { ...b.note, ...p } })),
    addHighlight: (tab, a) => edit(tab, (doc) => ({ ...doc, annotations: [...doc.annotations, a] })),
    // 新建不入栈：note 在首次 commitNoteText 之前是「未提交」状态（spec §6.1）
    addNote: (tab, n) => patch(tab, (b) =>
      (b.doc && !b.loadError ? { doc: { ...b.doc, annotations: [...b.doc.annotations, n] } } : {})),
    discardNote: (tab, id) => patch(tab, (b) =>
      (b.doc && !b.loadError ? { doc: without(b.doc, id), selectedId: b.selectedId === id ? null : b.selectedId } : {})),
    commitNoteText: (tab, id, text) => {
      const cur = get().buckets[tab]?.doc?.annotations.find((a) => a.id === id);
      if (!cur || cur.type !== 'note' || cur.text === text) return;
      const firstCommit = cur.text === '';
      edit(
        tab,
        (doc) => withAnn(doc, id, (a) => ({ ...(a as Note), text, updatedAt: new Date().toISOString() })),
        firstCommit ? (doc) => without(doc, id) : undefined,
      );
    },
    moveNote: (tab, id, x, y) => edit(tab, (doc) => withAnn(doc, id, (a) => ({ ...(a as Note), x, y }))),
    restyle: (tab, id, p) => edit(tab, (doc) => withAnn(doc, id, (a) => {
      if (a.type === 'highlight') {
        return { ...a, ...(p.color ? { color: p.color as HighlightColor } : {}), ...(p.level ? { width: p.level } : {}) };
      }
      return { ...a, ...(p.color ? { color: p.color as NoteColor } : {}), ...(p.level ? { size: p.level } : {}) };
    })),
    remove: (tab, id) => patch(tab, (b) => {
      if (!b.doc || b.loadError || !b.doc.annotations.some((a) => a.id === id)) return {};
      const newDoc = without(b.doc, id);
      return {
        doc: newDoc,
        undo: [...b.undo, b.doc].slice(-UNDO_LIMIT),
        redo: [],
        selectedId: b.selectedId === id ? null : b.selectedId,
      };
    }),
    select: (tab, id) => patch(tab, () => ({ selectedId: id })),
    undo: (tab) => patch(tab, (b) => {
      if (!b.doc || b.loadError || b.undo.length === 0) return {};
      const prev = b.undo[b.undo.length - 1];
      return { doc: prev, undo: b.undo.slice(0, -1), redo: [...b.redo, b.doc], selectedId: null };
    }),
    redo: (tab) => patch(tab, (b) => {
      if (!b.doc || b.loadError || b.redo.length === 0) return {};
      const next = b.redo[b.redo.length - 1];
      return { doc: next, redo: b.redo.slice(0, -1), undo: [...b.undo, b.doc].slice(-UNDO_LIMIT), selectedId: null };
    }),
  };
});
