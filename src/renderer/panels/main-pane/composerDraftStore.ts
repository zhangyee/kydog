import { create } from 'zustand';
import type { SkillEntry } from '../../../shared/types';

/** 与 Composer 内部那两个 state 一一对应：chip 上的 skill + 正文。 */
export type ComposerDraft = { skill: SkillEntry | null; body: string };

/** 没写过草稿的 thread 统一拿这一个常量，别在 selector 里现造对象 —— 每次
 *  渲染换新引用会让 zustand 认定状态变了，直接进无限重渲染。 */
export const EMPTY_DRAFT: ComposerDraft = { skill: null, body: '' };

type ComposerDraftState = {
  byThread: Record<string, ComposerDraft | undefined>;
  setDraft: (threadId: string, draft: ComposerDraft) => void;
  clearDraft: (threadId: string) => void;
};

/**
 * 未发送的输入按 thread 存在组件外。
 *
 * Composer 会被卸载的路径不止一条：切到 md / pdf / html 文件 tab、切到设置页、
 * 切到别的 thread —— MainPane 那边非文件内容是条件渲染，不是 display 隐藏。
 * 草稿留在组件 state 里，这几条路径上都会连人带字一起没。这里只存内存、不落盘：
 * 跨进程的输入恢复是另一件事，这个 store 不假装做到。
 */
export const useComposerDraftStore = create<ComposerDraftState>((set) => ({
  byThread: {},
  setDraft: (threadId, draft) =>
    set((s) => ({ byThread: { ...s.byThread, [threadId]: draft } })),
  clearDraft: (threadId) =>
    set((s) => {
      if (!s.byThread[threadId]) return {};
      const { [threadId]: _drop, ...rest } = s.byThread;
      return { byThread: rest };
    }),
}));
