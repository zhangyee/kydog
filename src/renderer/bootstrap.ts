import { useThreadsStore } from './stores/threadsStore';
import { useUiStore } from './stores/uiStore';
import { useSettingsStore } from './stores/settingsStore';
import { useRunsStore } from './stores/runsStore';
import { useLlmStore } from './stores/llmStore';
import { useSkillsStore } from './stores/skillsStore';
import { useUnreadStore } from './panels/workspace/unreadStore';

export async function bootstrap(): Promise<void> {
  const state = await window.kydog.invoke('app.bootstrap');
  useThreadsStore.getState().hydrate(state.projects, state.threads);
  useSettingsStore.getState().setSettings(state.settings);
  useSettingsStore.getState().setAppVersion(state.appVersion);
  await useLlmStore.getState().refresh();
  const noProvider = state.settings.llm.defaultProvider === null;
  useUiStore.setState({
    theme: state.settings.ui.theme,
    workspaceCollapsed: state.settings.ui.workspaceCollapsed,
    inspectorCollapsed: state.settings.ui.inspectorCollapsed,
    settingsTabOpen: noProvider,
    settingsTab: 'provider',
    activeCenterTab: noProvider ? 'settings' : 'thread',
  });

  let prev = useUiStore.getState();
  useUiStore.subscribe((s) => {
    if (s.theme === prev.theme && s.workspaceCollapsed === prev.workspaceCollapsed && s.inspectorCollapsed === prev.inspectorCollapsed) return;
    prev = s;
    const curSettings = useSettingsStore.getState().settings;
    void window.kydog.invoke('settings.update', {
      ui: {
        theme: s.theme,
        locale: 'zh',
        workspaceCollapsed: s.workspaceCollapsed,
        inspectorCollapsed: s.inspectorCollapsed,
        readingFontSize: curSettings?.ui.readingFontSize ?? 'medium',
      },
    }).catch((err) => console.error('persist ui failed', err));
  });

  setupEventBridge();

  // Fire-and-forget: pull installed skills so the Composer slash menu has real data.
  void window.kydog.invoke('skill.list')
    .then((skills) => useSkillsStore.getState().setSkills(skills))
    .catch((err) => console.error('skill.list failed', err));
}

function setupEventBridge(): void {
  const runs = useRunsStore.getState();
  const threads = useThreadsStore.getState();

  window.kydog.on('run.started', (p) => {
    useRunsStore.getState().setRun(p.threadId, { status: 'running', runId: p.runId });
  });
  window.kydog.on('run.thinking_delta', (p) => {
    const buf = useRunsStore.getState().bufferByMessage[p.messageId];
    if (!buf) useRunsStore.getState().startMessageBuffer(p.threadId, p.messageId);
    useRunsStore.getState().appendThinking(p.messageId, p.delta);
  });
  window.kydog.on('run.message_delta', (p) => {
    const buf = useRunsStore.getState().bufferByMessage[p.messageId];
    if (!buf) useRunsStore.getState().startMessageBuffer(p.threadId, p.messageId);
    useRunsStore.getState().appendDelta(p.messageId, p.delta);
  });
  window.kydog.on('run.tool_call_start', (p) => {
    // tool calls anchor on most-recent message buffer of this thread
    const allBufs = useRunsStore.getState().bufferByMessage;
    const target = Object.entries(allBufs).reverse().find(([, v]) => v.threadId === p.threadId)?.[0];
    if (target) useRunsStore.getState().addToolCall(target, p.toolCallId, p.name, p.command);
  });
  window.kydog.on('run.tool_call_chunk', (p) => {
    const allBufs = useRunsStore.getState().bufferByMessage;
    const target = Object.entries(allBufs).reverse().find(([, v]) =>
      v.threadId === p.threadId && v.blocks.some(b => b.kind === 'tool_call' && b.id === p.toolCallId)
    )?.[0];
    if (target) useRunsStore.getState().appendToolChunk(target, p.toolCallId, p.stream, p.chunk);
  });
  window.kydog.on('run.tool_call_end', (p) => {
    const allBufs = useRunsStore.getState().bufferByMessage;
    const target = Object.entries(allBufs).reverse().find(([, v]) =>
      v.threadId === p.threadId && v.blocks.some(b => b.kind === 'tool_call' && b.id === p.toolCallId)
    )?.[0];
    if (target) useRunsStore.getState().finalizeToolCall(target, p.toolCallId, p.status, p.exitCode);
  });
  window.kydog.on('run.parallel_group', (p) => {
    useRunsStore.getState().markParallelGroup(p.messageId, p.toolCallIds, p.parallelGroupId);
  });
  window.kydog.on('run.message_end', (p) => {
    const blocks = useRunsStore.getState().takeBuffer(p.messageId);
    if (!blocks) return;
    useThreadsStore.setState((s) => ({
      historyByThread: {
        ...s.historyByThread,
        [p.threadId]: [
          ...(s.historyByThread[p.threadId] ?? []),
          { id: p.messageId, role: 'assistant', createdAt: new Date().toISOString(), blocks },
        ],
      },
    }));
  });
  window.kydog.on('run.ended', (p) => {
    if (p.reason === 'error') {
      useRunsStore.getState().setRun(p.threadId, { status: 'error', error: p.errorMessage ?? 'unknown' });
    } else {
      useRunsStore.getState().setRun(p.threadId, { status: 'idle' });
    }
    const currentId = useThreadsStore.getState().currentThreadId;
    if (p.threadId !== currentId) {
      useUnreadStore.getState().markUnread(p.threadId);
    }
  });
  window.kydog.on('thread.updated', (p) => {
    useThreadsStore.getState().upsertThread(p.thread);
  });
  window.kydog.on('fs.changed', (p) => {
    void refreshCachedDirsUnder(p.projectPath);
  });

  void runs; void threads; // silence unused
}

function isWithin(dir: string, root: string): boolean {
  if (dir === root) return true;
  return dir.startsWith(root + '/') || dir.startsWith(root + '\\');
}

async function refreshCachedDirsUnder(projectPath: string): Promise<void> {
  const dirs = Object.keys(useUiStore.getState().dirCache).filter((d) => isWithin(d, projectPath));
  await Promise.all(dirs.map(async (dir) => {
    try {
      const nodes = await window.kydog.invoke('project.readDir', { path: dir });
      useUiStore.getState().setDir(dir, nodes);
    } catch (err) {
      useUiStore.getState().invalidateDir(dir);
      console.warn('fs.changed refresh failed', dir, err);
    }
  }));
}
