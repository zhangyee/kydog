import { usePdfAnnotationStore } from './pdfAnnotationStore';
import type { PdfAnnotationsFile } from '../../../../shared/pdfSidecar';

export type SaveFn = (pdfPath: string, doc: PdfAnnotationsFile) => Promise<void>;

const DEBOUNCE_MS = 300;

type Pending = { timer: ReturnType<typeof setTimeout> | null; inflight: boolean; next: PdfAnnotationsFile | null };

/** 从 store 取这一桶当前可写的 doc；未加载或 loadError 都返回 null。 */
function writableDoc(tab: string): PdfAnnotationsFile | null {
  const b = usePdfAnnotationStore.getState().buckets[tab];
  return b?.doc && !b.loadError ? b.doc : null;
}

/**
 * 防抖 300 ms、同一 tab 单飞、在途期间的改动补写一次、失败记进 saveError（spec §8.1 / §8.2）。
 * write 在第一个 await 之前就把要写的 doc 拿在手里：flush 之后调用方可以立刻 drop 桶，
 * 在途或排队中的那份不会因为桶没了而丢。
 */
export function createSaveScheduler(save: SaveFn) {
  const pending = new Map<string, Pending>();
  const stateOf = (tab: string): Pending => {
    let p = pending.get(tab);
    if (!p) { p = { timer: null, inflight: false, next: null }; pending.set(tab, p); }
    return p;
  };
  const write = async (tab: string, doc: PdfAnnotationsFile): Promise<void> => {
    const p = stateOf(tab);
    if (p.inflight) { p.next = doc; return; }   // 在途：记下最新的一份，完成后补写
    p.inflight = true;
    p.next = null;
    try {
      await save(tab, doc);
      usePdfAnnotationStore.getState().setSaveError(tab, null);
    } catch (err) {
      usePdfAnnotationStore.getState().setSaveError(tab, err instanceof Error ? err.message : String(err));
    } finally {
      p.inflight = false;
      if (p.next) { const n = p.next; p.next = null; void write(tab, n); }
    }
  };
  return {
    schedule(tab: string): void {
      const p = stateOf(tab);
      if (p.timer) clearTimeout(p.timer);
      p.timer = setTimeout(() => {
        p.timer = null;
        const doc = writableDoc(tab);
        if (doc) void write(tab, doc);
      }, DEBOUNCE_MS);
    },
    /** 立即写（关 tab、beforeunload、重试）。返回前已把 doc 快照交给 write，之后 drop 桶也不丢。 */
    flush(tab: string): Promise<void> {
      const p = stateOf(tab);
      if (p.timer) { clearTimeout(p.timer); p.timer = null; }
      const doc = writableDoc(tab);
      return doc ? write(tab, doc) : Promise.resolve();
    },
    forget(tab: string): void {
      const p = pending.get(tab);
      if (p?.timer) clearTimeout(p.timer);
      pending.delete(tab);
    },
  };
}

/** 订阅 store：某个桶的 doc 引用变了（且不是从 null 加载进来）就排一次保存。返回取消订阅函数。 */
export function watchDocs(scheduler: ReturnType<typeof createSaveScheduler>): () => void {
  let prev = usePdfAnnotationStore.getState().buckets;
  return usePdfAnnotationStore.subscribe((s) => {
    for (const [tab, b] of Object.entries(s.buckets)) {
      const before = prev[tab];
      if (before && before.doc !== null && b.doc !== null && b.doc !== before.doc) scheduler.schedule(tab);
    }
    prev = s.buckets;
  });
}

// 渲染进程里的单例。单测环境没有 window，SaveFn 只在真被调用时才碰它。
export const pdfSaveScheduler = createSaveScheduler((pdfPath, doc) =>
  window.kydog.invoke('pdf.annotations.save', { pdfPath, doc }));
if (typeof window !== 'undefined') watchDocs(pdfSaveScheduler);
