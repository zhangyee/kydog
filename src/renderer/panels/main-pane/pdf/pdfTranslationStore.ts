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
  prevScale: number | null;     // 进入对照前的缩放；退出时还原
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

type State = {
  buckets: Record<string, TBucket>;
  setLoaded: (tab: string, doc: TranslatedDoc | null, version: VersionState, dropped: number) => void;
  setLoadError: (tab: string, msg: string) => void;
  setDual: (tab: string, dual: boolean, prevScale?: number | null) => void;
  drop: (tab: string) => void;
};

export const usePdfTranslationStore = create<State>((set) => ({
  buckets: {},
  setLoaded: (tab, doc, version, dropped) => set((s) => ({
    buckets: { ...s.buckets, [tab]: { ...(s.buckets[tab] ?? emptyTBucket()), doc, version, dropped, loadError: null } },
  })),
  setLoadError: (tab, msg) => set((s) => ({
    buckets: { ...s.buckets, [tab]: { ...(s.buckets[tab] ?? emptyTBucket()), doc: null, loadError: msg, dual: false } },
  })),
  setDual: (tab, dual, prevScale = null) => set((s) => ({
    buckets: { ...s.buckets, [tab]: { ...(s.buckets[tab] ?? emptyTBucket()), dual, prevScale: dual ? prevScale : null } },
  })),
  drop: (tab) => set((s) => {
    const next = { ...s.buckets };
    delete next[tab];
    return { buckets: next };
  }),
}));
