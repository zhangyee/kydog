import { useThreadsStore, newThreadProjectPath } from './stores/threadsStore';
import { useUiStore } from './stores/uiStore';
import { useUnreadStore } from './panels/workspace/unreadStore';
import type { Thread } from '../shared/types';

/** 在给定项目里建一个新对话并切过去。项目行上的「+」走这里；它选中新对话，于是该项目也成了当前项目。 */
export async function startNewThread(projectPath: string): Promise<Thread> {
  const thread = await window.kydog.invoke('thread.create', { projectPath });
  useThreadsStore.getState().upsertThread(thread);
  useUiStore.getState().showThreadTab();
  useThreadsStore.getState().selectThread(thread.id);
  useUnreadStore.getState().markRead(thread.id);
  return thread;
}

/** 「新对话」按钮 / ⌘N / 欢迎页：建在当前项目里（见 threadsStore 的 focusedProjectPath）。一个项目都没有时返回 null。 */
export async function startNewThreadInFocusedProject(): Promise<Thread | null> {
  const projectPath = newThreadProjectPath(useThreadsStore.getState());
  return projectPath === null ? null : startNewThread(projectPath);
}
