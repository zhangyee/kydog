export type Cleanable = { cleanup(): void };

export type PageLifecycle = {
  acquire(page: number): void;
  release(page: number): void;
  sweep(inWindow: (page: number) => boolean): void;
  cleanedCount(): number;
};

/**
 * 什么时候把一页还给 pdf.js。
 *
 * 卸载 canvas 只释放位图；page proxy 仍握着绘制指令和已解码的图像，要 cleanup() 才还。
 * 但 cleanup() 会打断在途的渲染，所以判据必须是「没有任何层还在用这一页」——
 * 双缓冲期间同一页在两层上各有一格，只有旧层那格卸载时清就会把新层画到一半的图弄没。
 *
 * 引用归零之后还要再看一眼窗口：预取的页引用为 0 但马上要用，清了等于白预取。
 *
 * 数据结构上的关键点：`refs` 里引用数降到 0 之后**不删除条目**，而是留一个值为 0 的条目。
 * 这不是随手的选择——它是 sweep 能补清「引用早归零、当时因为在窗口内被跳过的页」的唯一依据。
 * 如果像最省事的写法那样在归零时 `refs.delete(page)`，那么一旦某次 sweep 因为该页仍在窗口内
 * 而放它一马，这一页就从 refs 里彻底消失，之后窗口挪走了也没有任何结构记得「它还欠一次清理」——
 * 下一次 sweep 无从查起。留着 0 值条目，refs 本身就是「当前所有引用计数」的完整、可重复查询的
 * 真相来源，sweep 每次都能重新扫一遍找出「计数为 0 且不在窗口内」的页，不管这是第几次找它。
 * 条目只在真正调用了 cleanup() 之后才从 refs 里删掉（run 的最后一步）。
 *
 * `pending` 记的是「已经排了一次清理、还没跑到」的页，用来防重复排队，也用来在 acquire /
 * sweep 判定「还在窗口内」时取消这次排队——run() 执行时先 `pending.delete(page)`，删不掉
 * （说明中途被取消了）就直接放弃，不碰 getProxy，避免清一个又要用的页。
 */
export function createPageLifecycle(
  getProxy: (page: number) => Cleanable | undefined,
  schedule: (fn: () => void) => void = queueMicrotask,
): PageLifecycle {
  const refs = new Map<number, number>();
  const pending = new Set<number>();
  let cleaned = 0;

  const run = (page: number) => {
    if (!pending.delete(page)) return;       // 已被取消（重新 acquire，或 sweep 发现仍在窗口内）
    if ((refs.get(page) ?? 0) > 0) return;    // 双重保险：排队期间又被持有
    // 只有真的调了 cleanup() 才计数：proxy 不存在（换文件已经把 pageProxies 整个丢掉、或这页
    // 压根没加载成功）时什么都没还回去，把它算进去会让探针分不清「清了」与「决定要清」。
    const proxy = getProxy(page);
    if (proxy) { proxy.cleanup(); cleaned += 1; }
    refs.delete(page);                        // 这一页的账已经了结（清了，或确认无可清），refs 不必再记
  };

  return {
    acquire(page) {
      refs.set(page, (refs.get(page) ?? 0) + 1);
      pending.delete(page); // 又要用了，取消排队中的清理（若有）
    },
    release(page) {
      const next = (refs.get(page) ?? 1) - 1;
      refs.set(page, Math.max(0, next));
      if (next > 0) return; // 还有别的层持有
      if (!pending.has(page)) {
        pending.add(page);
        schedule(() => run(page));
      }
    },
    sweep(inWindow) {
      // 只看当前引用计数为 0 的页——这些是「没有任何层挂着，但还没确定能不能清」的候选。
      for (const [page, count] of refs) {
        if (count !== 0) continue;
        if (inWindow(page)) {
          pending.delete(page); // 还在窗口内：撤销排队中的清理，这页留着
        } else if (!pending.has(page)) {
          pending.add(page);    // 不在窗口内了：补排一次清理（覆盖「早归零、当时被放过一马」的页）
          schedule(() => run(page));
        }
      }
    },
    cleanedCount: () => cleaned,
  };
}
