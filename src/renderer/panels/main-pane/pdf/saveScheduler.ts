import { usePdfAnnotationStore } from './pdfAnnotationStore';
import type { PdfAnnotationsFile } from '../../../../shared/pdfSidecar';

export type SaveFn = (pdfPath: string, doc: PdfAnnotationsFile) => Promise<void>;

const DEBOUNCE_MS = 300;

type Pending = {
  timer: ReturnType<typeof setTimeout> | null;
  inflight: Promise<void> | null;                                   // 当前在途写入完成的 promise
  next: PdfAnnotationsFile | null;                                  // 在途期间到达的最新一份
  nextDone: { promise: Promise<void>; resolve: () => void } | null; // 等补写落盘的调用方
  // 队列全部结算之后磁盘上会是哪一份（序列化后的字符串）。null = 不知道（没加载过，或上次写失败）。
  // 它就是「不必再写」的判据：要写的内容与它逐字节相同，这次写入是空操作。
  target: string | null;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const serialize = (doc: PdfAnnotationsFile): string => JSON.stringify(doc);

/** 从 store 取这一桶当前可写的 doc；未加载或 loadError 都返回 null。 */
function writableDoc(tab: string): PdfAnnotationsFile | null {
  const b = usePdfAnnotationStore.getState().buckets[tab];
  return b?.doc && !b.loadError ? b.doc : null;
}

/**
 * 防抖 300 ms、同一 tab 单飞、在途期间的改动补写一次、失败记进 saveError（spec §8.1 / §8.2）。
 * write 在第一个 await 之前就把要写的 doc 拿在手里：flush 之后调用方可以立刻 drop 桶，
 * 在途或排队中的那份不会因为桶没了而丢。返回的 promise 在这份 doc（或替代它的更新一份）
 * 真正写完后才 settle。补写沿用同一个 Pending 对象，forget 之后不会在 map 里重新造一个。
 * forget 只停定时器、丢跟踪，不取消已经在途或已排队的写入。
 *
 * 内容没变就不写盘（`target`）：打开一个还没有边车的 PDF、看两眼就关掉，不该在论文旁边留下一个
 * 空标注文件（用户反馈 6）—— 关 tab 会 flush，而 flush 从前是无条件写。判据用「要写的字节与磁盘上
 * 的字节相同」这个事实，不用「用户有没有动过」这类旁证。
 */
export function createSaveScheduler(save: SaveFn) {
  const pending = new Map<string, Pending>();
  const stateOf = (tab: string): Pending => {
    let p = pending.get(tab);
    if (!p) { p = { timer: null, inflight: null, next: null, nextDone: null, target: null }; pending.set(tab, p); }
    return p;
  };
  // force：从队列里取出来的那一份必须真写 —— 它排队时就已经把 target 设成自己了，再比一次必然相等。
  const write = (tab: string, doc: PdfAnnotationsFile, p: Pending, force = false): Promise<void> => {
    const text = serialize(doc);
    if (!force && p.target === text) return Promise.resolve();
    p.target = text;
    if (p.inflight) {
      p.next = doc;
      if (!p.nextDone) p.nextDone = deferred();
      return p.nextDone.promise;
    }
    const run = (async () => {
      try {
        await save(tab, doc);
        usePdfAnnotationStore.getState().setSaveError(tab, null);
      } catch (err) {
        p.target = null;   // 磁盘上是哪一份不再确定；下次（含「重试」按钮）照写
        usePdfAnnotationStore.getState().setSaveError(tab, err instanceof Error ? err.message : String(err));
      }
    })();
    const done = run.then(() => {
      p.inflight = null;
      if (p.next) {
        const n = p.next;
        const d = p.nextDone;
        p.next = null;
        p.nextDone = null;
        void write(tab, n, p, true).then(() => d?.resolve());
      }
    });
    p.inflight = done;
    return done;
  };
  return {
    schedule(tab: string): void {
      const p = stateOf(tab);
      if (p.timer) clearTimeout(p.timer);
      p.timer = setTimeout(() => {
        p.timer = null;
        const doc = writableDoc(tab);
        if (doc) void write(tab, doc, p);
      }, DEBOUNCE_MS);
    },
    /** 立即写（关 tab、beforeunload、重试）。返回前已把 doc 快照交给 write；resolve 时这份已落盘（失败也算 settle，错误在 store 的 saveError 里）。内容与磁盘相同则不写。 */
    flush(tab: string): Promise<void> {
      const p = stateOf(tab);
      if (p.timer) { clearTimeout(p.timer); p.timer = null; }
      const doc = writableDoc(tab);
      return doc ? write(tab, doc, p) : Promise.resolve();
    },
    /** 记下「磁盘上现在就是这份」。加载完边车（或确认没有边车、doc 是空文档）时调，之后没改动就不会写盘。 */
    markClean(tab: string, doc: PdfAnnotationsFile): void {
      stateOf(tab).target = serialize(doc);
    },
    /** 停定时器、丢跟踪；不取消已在途或已排队的写入。 */
    forget(tab: string): void {
      const p = pending.get(tab);
      if (p?.timer) clearTimeout(p.timer);
      pending.delete(tab);
    },
  };
}

/**
 * 订阅 store：某个桶的 doc 引用变了就排一次保存。
 * 「doc 从 null 变成有值」是加载而不是编辑：这时记成干净（磁盘上就是这份），不排保存。
 * 返回取消订阅函数。
 */
export function watchDocs(scheduler: ReturnType<typeof createSaveScheduler>): () => void {
  let prev = usePdfAnnotationStore.getState().buckets;
  return usePdfAnnotationStore.subscribe((s) => {
    for (const [tab, b] of Object.entries(s.buckets)) {
      const before = prev[tab];
      if (b.doc === null) continue;
      if (!before || before.doc === null) { scheduler.markClean(tab, b.doc); continue; }
      if (b.doc !== before.doc) scheduler.schedule(tab);
    }
    prev = s.buckets;
  });
}

// 渲染进程里的单例。单测环境没有 window，SaveFn 只在真被调用时才碰它。
export const pdfSaveScheduler = createSaveScheduler((pdfPath, doc) =>
  window.kydog.invoke('pdf.annotations.save', { pdfPath, doc }));
if (typeof window !== 'undefined') watchDocs(pdfSaveScheduler);
