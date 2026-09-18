import { create } from 'zustand';
import type { HarnessFileName, HarnessFileStatus, HarnessReadResult } from '../../shared/types';

/**
 * 编辑中的一份 harness 文件。base 是进入编辑时从磁盘读到的原文（保存时作 expected 做比较后写），
 * text 是文本框里的内容。base 为 null：编辑期间文件被删了，用户选了用自己的版本覆盖。
 */
export type HarnessDraft = { base: string | null; text: string };

type HarnessState = {
  /** 在右侧检视栏里打开的是哪一份；null = 没打开（检视栏显示它平常的内容）。存组件外：离开长期记忆页再回来还开着。 */
  opened: HarnessFileName | null;
  /**
   * 打开的那一份是在看还是在改。**与「有没有草稿」是两件事**：草稿离开页面、切到别的文件都留着（决策 10），
   * 但点「查看」就该看到查看态 —— 拿「有草稿」当「在编辑」的话，编辑过一次、关掉再点查看，出来的还是编辑框。
   */
  mode: 'view' | 'edit';
  drafts: Partial<Record<HarnessFileName, HarnessDraft>>;
  /** 启动对话框改了文件就 +1，长期记忆页据此重新拉状态（它可能正开在对话框底下）。 */
  revision: number;
  /** 最近一次拉到的三份状态与内容 —— 长期记忆页的卡片与检视栏共用这一份，不各拉各的。 */
  statuses: HarnessFileStatus[] | null;
  docs: Partial<Record<HarnessFileName, HarnessReadResult>>;
  loadError: string | null;
  /** 某一份最近一次动作的结果（已更新、已保存、失败原因），显示在检视栏里。 */
  notes: Partial<Record<HarnessFileName, string>>;
  /** 有一个保存 / 更新在途。 */
  busy: boolean;
  setOpened: (name: HarnessFileName | null, mode?: 'view' | 'edit') => void;
  setMode: (mode: 'view' | 'edit') => void;
  setDraft: (name: HarnessFileName, draft: HarnessDraft) => void;
  clearDraft: (name: HarnessFileName) => void;
  bumpRevision: () => void;
  setLoaded: (statuses: HarnessFileStatus[], docs: Partial<Record<HarnessFileName, HarnessReadResult>>) => void;
  setDoc: (name: HarnessFileName, doc: HarnessReadResult) => void;
  setLoadError: (err: string | null) => void;
  setNote: (name: HarnessFileName, note: string | null) => void;
  setBusy: (busy: boolean) => void;
};

/**
 * 草稿存在组件外（spec 决策 10）：设置页在切 tab、点侧栏会话、关设置 tab 时直接卸载，
 * 没有可挂的导航拦截。与 composerDraftStore 同一个理由、同一种做法：只存内存、不落盘。
 * 这个 store 只存状态；调主进程的是 settings/harnessActions.ts。
 */
export const useHarnessStore = create<HarnessState>((set) => ({
  opened: null,
  mode: 'view',
  drafts: {},
  revision: 0,
  statuses: null,
  docs: {},
  loadError: null,
  notes: {},
  busy: false,
  setOpened: (name, mode = 'view') => set({ opened: name, mode }),
  setMode: (mode) => set({ mode }),
  setDraft: (name, draft) => set((s) => ({ drafts: { ...s.drafts, [name]: draft } })),
  clearDraft: (name) => set((s) => {
    if (!s.drafts[name]) return {};
    const { [name]: _drop, ...rest } = s.drafts;
    return { drafts: rest };
  }),
  bumpRevision: () => set((s) => ({ revision: s.revision + 1 })),
  setLoaded: (statuses, docs) => set({ statuses, docs, loadError: null }),
  setDoc: (name, doc) => set((s) => ({ docs: { ...s.docs, [name]: doc } })),
  setLoadError: (err) => set({ loadError: err }),
  setNote: (name, note) => set((s) => {
    if (note === null) {
      if (!(name in s.notes)) return {};
      const { [name]: _drop, ...rest } = s.notes;
      return { notes: rest };
    }
    return { notes: { ...s.notes, [name]: note } };
  }),
  setBusy: (busy) => set({ busy }),
}));

/** 文本框按 HTML 规定把 \r\n、单独的 \r 都归一成 \n；「改没改」要拿归一化后的原文比。 */
export const toTextareaNewlines = (s: string) => s.replace(/\r\n?/g, '\n');

export function isDraftDirty(d: HarnessDraft): boolean {
  return d.base === null || d.text !== toTextareaNewlines(d.base);
}
