import { useThreadsStore } from './stores/threadsStore';
import { useUiStore } from './stores/uiStore';
import { useSettingsStore } from './stores/settingsStore';
import { useLlmStore } from './stores/llmStore';
import { useSkillsStore } from './stores/skillsStore';
import { useIdentityStore } from './stores/identityStore';
import { useUpdateStore } from './stores/updateStore';
import { useFileIndexStore } from './stores/fileIndexStore';
import { applyRunEvent } from './runEvents';
import { restoreViewState, installViewStateSync } from './viewState';
import { RUN_EVENT_TOPICS, type RunEvent } from '../shared/protocol';
import { useBrowserStore } from './panels/browser/browserStore';
import { installBrowserBridge } from './panels/browser/browserBridge';
import { installWatchSync, loadDir } from './fsWatch';

export async function bootstrap(): Promise<void> {
  const state = await window.kydog.invoke('app.bootstrap');
  useThreadsStore.getState().hydrate(state.projects, state.threads);
  useSettingsStore.getState().setSettings(state.settings);
  useSettingsStore.getState().setAppVersion(state.appVersion);
  useIdentityStore.getState().setIdentity(state.identity);
  useSettingsStore.getState().setBootstrapMeta({
    systemLocale: state.systemLocale,
    onboardingRecovery: state.onboardingRecovery,
    settingsHealth: state.settingsHealth,
  });
  const noProvider = state.settings.llm.defaultProvider === null;
  // 落盘的收起记录里，指向已被移除的 project 的那些留着也没人再读，
  // 只会随着开开关关无限长；在唯一知道当前 project 全集的地方剪掉。
  const knownProjects = new Set(state.projects.map((p) => p.path));
  useUiStore.setState({
    theme: state.settings.ui.theme,
    readingFontSize: state.settings.ui.readingFontSize,
    workspaceCollapsed: state.settings.ui.workspaceCollapsed,
    inspectorCollapsed: state.settings.ui.inspectorCollapsed,
    collapsedProjects: new Set(state.settings.ui.collapsedProjects.filter((p) => knownProjects.has(p))),
    browserOpen: state.settings.ui.browserOpen,
    browserWidth: state.settings.ui.browserWidth,
    settingsTabOpen: noProvider,
    settingsTab: 'provider',
    activeCenterTab: noProvider ? 'settings' : 'thread',
  });

  // 排在 restoreViewState 之前：它会把上次的文件标签开回来，而标签要先进监听集合、再去读盘
  // （先声明、再读，见 fsWatch.ts）。装上时发的第一份还顺带替换掉重载前那一页声明的集合。
  installWatchSync();

  // 渲染进程重载后接回原处。必须排在上面那次 setState 之后 —— 它会把 activeCenterTab
  // 重置掉。noProvider 时把 activeCenterTab 让给上面的强制设置页，只把 tab 开回来。
  // 已归档的（archivedAt 有值）不算「已知」：threadsStore.hydrate 的桶里已经把它们滤掉了
  // （唯一过滤点，见 threadsStore.ts），这里是第二个读 state.threads 的地方，得照抄同一条
  // 规则——否则记着的 thread 恰好是刚被归档的那个，重启后会把一个不在左栏里的会话选中。
  const knownThreadIds = new Set(state.threads.filter((t) => !t.archivedAt).map((t) => t.id));
  restoreViewState(state.viewState, knownThreadIds, noProvider);
  installViewStateSync();

  let prev = useUiStore.getState();
  useUiStore.subscribe((s) => {
    if (
      s.theme === prev.theme
      && s.readingFontSize === prev.readingFontSize
      && s.workspaceCollapsed === prev.workspaceCollapsed
      && s.inspectorCollapsed === prev.inspectorCollapsed
      && s.browserOpen === prev.browserOpen
      && s.browserWidth === prev.browserWidth
      // Set 每次改动都换新引用，比引用就够了，不必逐元素比
      && s.collapsedProjects === prev.collapsedProjects
    ) return;
    prev = s;
    void window.kydog.invoke('settings.update', {
      ui: {
        theme: s.theme,
        workspaceCollapsed: s.workspaceCollapsed,
        inspectorCollapsed: s.inspectorCollapsed,
        readingFontSize: s.readingFontSize,
        collapsedProjects: [...s.collapsedProjects],
        browserOpen: s.browserOpen,
        browserWidth: s.browserWidth,
      },
    }).catch((err) => console.error('persist ui failed', err));
  });

  setupEventBridge();

  // 内置浏览器的两条订阅 + 恢复协议（先订阅 → getState → 按 revision 去旧）。
  // **顺序与「接哪两条」都在那个模块里**，理由与它自己的用例见 browserBridge.ts ——
  // 这几句放在 bootstrap 里的话，接反了三条 gate 全绿（实测）。
  installBrowserBridge(window.kydog, useBrowserStore.getState());

  // 排在 setupEventBridge 之后，不在前面：主进程那次后台目录刷新是 fire-and-forget 的，
  // 先读清单再订阅的话，落在这两步之间的 llm.listChanged 就没人接——清单会一直停在
  // 内置那份，直到用户下一次动作。先订阅再读，这个缝就不存在了。
  await useLlmStore.getState().refresh();

  window.kydog.on('update.status', (s) => useUpdateStore.getState().setStatus(s));
  void window.kydog.invoke('update.getStatus')
    .then((s) => useUpdateStore.getState().setStatus(s))
    .catch((err) => console.error('update.getStatus failed', err));

  // Fire-and-forget: pull installed skills so the Composer slash menu has real data.
  void window.kydog.invoke('skill.list')
    .then((skills) => useSkillsStore.getState().setSkills(skills))
    .catch((err) => console.error('skill.list failed', err));

  // 启动那次 sync 成没成，只有主进程知道；Settings 的提示读的就是这一份。
  void window.kydog.invoke('skill.getSyncHealth')
    .then((h) => useUiStore.getState().setSkillSyncHealth(h))
    .catch((err) => console.error('skill.getSyncHealth failed', err));

  // 布局要按窗口宽算 4:6 与对话栏下限（rightPane.ts）。装在这里而不是组件里：
  // 组件那一层跑在 environment:'node' 的用例里，没有 window 也没有 ResizeObserver，
  // 挂了会当场抛，而 ThreeColumnLayout.test.tsx 正靠真挂载组件守两条历史变异。
  const syncWindowWidth = () => useUiStore.getState().setWindowWidth(window.innerWidth);
  syncWindowWidth();
  window.addEventListener('resize', syncWindowWidth);

  useSettingsStore.getState().setBootstrapped(true);
}

function setupEventBridge(): void {
  // 全部 run.* 都汇到 applyRunEvent 一个口子：loadHistory 的 journal 重放走的也是它，
  // 直播与重放必须是同一段代码，否则重载后复原出来的 block 会慢慢跟直播的走偏。
  for (const topic of RUN_EVENT_TOPICS) {
    window.kydog.on(topic, (payload) => {
      applyRunEvent({ topic, payload } as RunEvent);
    });
  }
  window.kydog.on('thread.updated', (p) => {
    useThreadsStore.getState().upsertThread(p.thread);
  });
  window.kydog.on('fs.changed', (p) => {
    // 只重读自己缓存着的：主进程按所有窗口声明的并集发，别的窗口在看的目录不归这里管。
    if (p.dir in useUiStore.getState().dirCache) void loadDir(p.dir);
  });
  window.kydog.on('file.changed', (p) => {
    useUiStore.getState().markFileChanged(p.path);
  });
  window.kydog.on('project.fileIndexUpdated', (p) => {
    useFileIndexStore.getState().bump(p.projectPath);
  });
  window.kydog.on('identity.changed', (id) => {
    useIdentityStore.getState().setIdentity(id);
  });
  // 主进程后台拉完 pi.dev 的模型目录后推的整份快照。渲染层自己没有别的办法知道它落地了。
  window.kydog.on('llm.listChanged', (r) => {
    useLlmStore.getState().setSnapshot(r);
  });
  // 两条 browser.* 不在这里接 —— 它们与 browser.getState 是一套有顺序的恢复协议，
  // 整套在 panels/browser/browserBridge.ts（那边有用例守着顺序）。
}
