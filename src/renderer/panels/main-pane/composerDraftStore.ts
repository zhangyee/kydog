import { create } from 'zustand';
import type { SkillEntry } from '../../../shared/types';

export type DraftAttachment =
  | { id: string; kind: 'image'; name: string; absPath: string | null; data: string; mimeType: string }
  | { id: string; kind: 'file'; name: string; absPath: string };
export type NewAttachment =
  | Omit<Extract<DraftAttachment, { kind: 'image' }>, 'id'>
  | Omit<Extract<DraftAttachment, { kind: 'file' }>, 'id'>;

/** 待发的一条批注。`absPath` 是被批注文件的绝对路径，发送时才按对话的项目换成相对路径。 */
export type PendingComment = { id: string; absPath: string; section?: string; quote: string; note: string; sourceTabId: string };

/** 与 Composer 一一对应：chip 上的 skill、正文（@ 引用已是 refTag 形态）、附件、批注。 */
export type ComposerDraft = {
  skill: SkillEntry | null;
  body: string;
  attachments: DraftAttachment[];
  comments: PendingComment[];
  /** 「截图 N」的 N：一份草稿里只增不减，删了不复用。 */
  screenshotSeq: number;
  /** 托盘下方那一行说明（图片读不出、文件不在盘上……）。下一次改动草稿时清掉。 */
  notice: string | null;
};

/** 没写过草稿的 thread 统一拿这一个常量，别在 selector 里现造对象 —— 每次
 *  渲染换新引用会让 zustand 认定状态变了，直接进无限重渲染。 */
export const EMPTY_DRAFT: ComposerDraft = { skill: null, body: '', attachments: [], comments: [], screenshotSeq: 0, notice: null };

export function isDraftEmpty(d: ComposerDraft): boolean {
  return d.skill === null && d.body.trim() === '' && d.attachments.length === 0 && d.comments.length === 0;
}

type ComposerDraftState = {
  byThread: Record<string, ComposerDraft | undefined>;
  /** 只换正文部分；附件与批注留着。 */
  setDraft: (threadId: string, text: { skill: SkillEntry | null; body: string }) => void;
  clearDraft: (threadId: string) => void;
  /** 同一磁盘路径不重复添加；没有路径的（粘贴的截图）照单全收。 */
  addAttachments: (threadId: string, items: NewAttachment[]) => void;
  removeAttachment: (threadId: string, id: string) => void;
  takeScreenshotName: (threadId: string) => string;
  addComment: (threadId: string, c: Omit<PendingComment, 'id'>) => string;
  removeComment: (threadId: string, id: string) => void;
  clearComments: (threadId: string) => void;
  setNotice: (threadId: string, text: string | null) => void;
  /** 发送被拒时放回（spec §7）：当前草稿已非空就不覆盖。 */
  restoreDraft: (threadId: string, draft: ComposerDraft) => void;
};

/**
 * 未发送的输入按 thread 存在组件外。
 *
 * Composer 会被卸载的路径不止一条：切到 md / pdf / html 文件 tab、切到设置页、
 * 切到别的 thread —— MainPane 那边非文件内容是条件渲染，不是 display 隐藏。
 * 草稿留在组件 state 里，这几条路径上都会连人带字一起没。这里只存内存、不落盘：
 * 跨进程的输入恢复是另一件事，这个 store 不假装做到（批注与附件同样只在内存，spec §1.5）。
 */
export const useComposerDraftStore = create<ComposerDraftState>((set, get) => {
  const update = (threadId: string, f: (d: ComposerDraft) => ComposerDraft) =>
    set((s) => ({ byThread: { ...s.byThread, [threadId]: f(s.byThread[threadId] ?? EMPTY_DRAFT) } }));
  return {
    byThread: {},
    setDraft: (threadId, text) => update(threadId, (d) => ({ ...d, skill: text.skill, body: text.body, notice: null })),
    clearDraft: (threadId) =>
      set((s) => {
        if (!s.byThread[threadId]) return {};
        const { [threadId]: _drop, ...rest } = s.byThread;
        return { byThread: rest };
      }),
    addAttachments: (threadId, items) => update(threadId, (d) => {
      const have = new Set(d.attachments.map((a) => a.absPath).filter((p): p is string => p !== null));
      const next = [...d.attachments];
      for (const it of items) {
        if (it.absPath !== null && have.has(it.absPath)) continue;
        if (it.absPath !== null) have.add(it.absPath);
        next.push({ ...it, id: crypto.randomUUID() } as DraftAttachment);
      }
      return { ...d, attachments: next, notice: null };
    }),
    removeAttachment: (threadId, id) => update(threadId, (d) => ({ ...d, attachments: d.attachments.filter((a) => a.id !== id), notice: null })),
    takeScreenshotName: (threadId) => {
      const n = (get().byThread[threadId] ?? EMPTY_DRAFT).screenshotSeq + 1;
      update(threadId, (d) => ({ ...d, screenshotSeq: n }));
      return `截图 ${n}`;
    },
    addComment: (threadId, c) => {
      const id = crypto.randomUUID();
      update(threadId, (d) => ({ ...d, comments: [...d.comments, { ...c, id }], notice: null }));
      return id;
    },
    removeComment: (threadId, id) => update(threadId, (d) => ({ ...d, comments: d.comments.filter((c) => c.id !== id), notice: null })),
    clearComments: (threadId) => update(threadId, (d) => ({ ...d, comments: [] })),
    setNotice: (threadId, text) => update(threadId, (d) => ({ ...d, notice: text })),
    restoreDraft: (threadId, draft) =>
      set((s) => {
        const current = s.byThread[threadId];
        if (current && !isDraftEmpty(current)) return {};
        return { byThread: { ...s.byThread, [threadId]: draft } };
      }),
  };
});
