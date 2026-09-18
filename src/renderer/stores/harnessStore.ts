import { create } from 'zustand';
import type { HarnessFileName } from '../../shared/types';

/**
 * 编辑中的一份 harness 文件。base 是进入编辑时从磁盘读到的原文（保存时作 expected 做比较后写），
 * text 是文本框里的内容。base 为 null：编辑期间文件被删了，用户选了用自己的版本覆盖。
 */
export type HarnessDraft = { base: string | null; text: string };

type HarnessState = {
  /** 当前看的是哪一份。存组件外：离开长期记忆页再回来还停在原处。 */
  active: HarnessFileName;
  /** 有草稿 = 这一份处于编辑态。 */
  drafts: Partial<Record<HarnessFileName, HarnessDraft>>;
  /** 启动对话框改了文件就 +1，长期记忆页据此重新拉状态（它可能正开在对话框底下）。 */
  revision: number;
  setActive: (name: HarnessFileName) => void;
  setDraft: (name: HarnessFileName, draft: HarnessDraft) => void;
  clearDraft: (name: HarnessFileName) => void;
  bumpRevision: () => void;
};

/**
 * 草稿存在组件外（spec 决策 10）：设置页在切 tab、点侧栏会话、关设置 tab 时直接卸载，
 * 没有可挂的导航拦截。与 composerDraftStore 同一个理由、同一种做法：只存内存、不落盘。
 */
export const useHarnessStore = create<HarnessState>((set) => ({
  active: 'SOUL.md',
  drafts: {},
  revision: 0,
  setActive: (name) => set({ active: name }),
  setDraft: (name, draft) => set((s) => ({ drafts: { ...s.drafts, [name]: draft } })),
  clearDraft: (name) => set((s) => {
    if (!s.drafts[name]) return {};
    const { [name]: _drop, ...rest } = s.drafts;
    return { drafts: rest };
  }),
  bumpRevision: () => set((s) => ({ revision: s.revision + 1 })),
}));

/** 文本框按 HTML 规定把 \r\n、单独的 \r 都归一成 \n；「改没改」要拿归一化后的原文比。 */
export const toTextareaNewlines = (s: string) => s.replace(/\r\n?/g, '\n');

export function isDraftDirty(d: HarnessDraft): boolean {
  return d.base === null || d.text !== toTextareaNewlines(d.base);
}
