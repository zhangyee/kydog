// 左格画完的 canvas 跨树交给右格（对照壳 spec v8 §3.1「左格 canvas 跨树共享」）。
//
// 两格现在在两个滚动容器、两棵子树里，MountedPageCells 那份本地 state 传不过去。放 React state
// 又会让每一页 settle 都重渲染整个 PdfFileTab（1200 行 JSX）。所以是一个按 key 订阅的小注册表，
// 右格用 useSyncExternalStore 只订阅自己那一格。

export const cellKey = (layerId: number, page: number): string => `${layerId}:${page}`;

export type CanvasRegistry = {
  get(key: string): HTMLCanvasElement | null;
  set(key: string, c: HTMLCanvasElement | null): void;
  subscribe(key: string, cb: () => void): () => void;
};

export function createCanvasRegistry(): CanvasRegistry {
  const map = new Map<string, HTMLCanvasElement>();
  const subs = new Map<string, Set<() => void>>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, c) => {
      if ((map.get(key) ?? null) === c) return;       // 同一个元素不通知：右格会白合成一次
      if (c) map.set(key, c); else map.delete(key);
      subs.get(key)?.forEach((cb) => cb());
    },
    subscribe: (key, cb) => {
      let s = subs.get(key);
      if (!s) { s = new Set(); subs.set(key, s); }
      s.add(cb);
      return () => { s!.delete(cb); if (s!.size === 0) subs.delete(key); };
    },
  };
}
