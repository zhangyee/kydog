import { confirm } from '../../stores/confirmStore';
import { useThreadsStore } from '../../stores/threadsStore';
import { useToastStore } from '../../stores/toastStore';
import { useUnreadStore } from './unreadStore';
import { useComposerDraftStore } from '../main-pane/composerDraftStore';
import type { Thread } from '../../../shared/types';

/**
 * 归档 / 撤销 / 删除，单个与批量共用：调 RPC → 改 store → 出提示
 * （spec 2026-09-21-thread-archive-design §2.4、§2.5、§4.1）。ThreadRow 只负责把 thread 交过来。
 */

/** 按 id 从左栏现有的 thread 里取对象（顺序按 ids）。 */
export function threadsByIds(ids: readonly string[]): Thread[] {
  const all = Object.values(useThreadsStore.getState().threadsByProject).flat();
  return ids.map((id) => all.find((t) => t.id === id)).filter((t): t is Thread => t !== undefined);
}

export async function archiveThreads(threads: Thread[]): Promise<void> {
  const ids = threads.map((t) => t.id);
  let archived: Thread[];
  try {
    ({ threads: archived } = await window.kydog.invoke('thread.archive', { threadIds: ids }));
  } catch (err) {
    const code = (err as { code?: string }).code;
    useToastStore.getState().show({ message: code === 'thread.busy' ? '有对话正在运行，没有归档' : '归档失败' });
    console.error('archive threads failed', err);
    return;
  }
  // upsert 一个带 archivedAt 的 thread = 让它出桶；正开着的话 store 自己清 current（threadsStore §3.4）。
  for (const t of archived) {
    useThreadsStore.getState().upsertThread(t);
    useUnreadStore.getState().clearOne(t.id);
  }
  // 草稿（composerDraftStore）刻意不清：撤销回来还在。
  const message = threads.length === 1 ? `已归档「${threads[0].title}」` : `已归档 ${threads.length} 个对话`;
  useToastStore.getState().show({ message, action: { label: '撤销', run: () => { void unarchiveThreads(ids); } } });
}

export async function unarchiveThreads(ids: string[]): Promise<void> {
  try {
    const { threads } = await window.kydog.invoke('thread.unarchive', { threadIds: ids });
    // 回到原位置（lastActiveAt 没被归档动过）；不自动重新打开。
    for (const t of threads) useThreadsStore.getState().upsertThread(t);
  } catch (err) {
    console.error('unarchive threads failed', err);
    useToastStore.getState().show({ message: '撤销失败' });
  }
}

export async function deleteThreads(threads: Thread[]): Promise<boolean> {
  const title = threads.length === 1 ? `删除对话「${threads[0].title}」？` : `删除 ${threads.length} 个对话？`;
  const ok = await confirm({ title, message: '对话记录会从磁盘上删除，无法恢复。', confirmLabel: '删除' });
  if (!ok) return false;
  try {
    await window.kydog.invoke('thread.delete', { threadIds: threads.map((t) => t.id) });
  } catch (err) {
    console.error('delete threads failed', err);
    return false;
  }
  for (const t of threads) {
    useUnreadStore.getState().clearOne(t.id);
    useComposerDraftStore.getState().clearDraft(t.id);
    useThreadsStore.getState().removeThread(t.id);
  }
  return true;
}
