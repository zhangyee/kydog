import { useThreadsStore } from './stores/threadsStore';
import { useUiStore } from './stores/uiStore';
import type { CenterViewState } from '../shared/types';

/**
 * 中央区当前在看什么，摘成一份可上报的快照。
 *
 * 只取路径与选择：FileTab 的 kind / title / 磁盘内容 / dirty 全都由 openFile() 与
 * 各自的 tab 组件重建，抄一份过去只会变成第二份会过期的真相。
 *
 * activeCenterTab 是 'settings' 时按 'thread' 记：设置页什么时候顶到前面由 bootstrap
 * 自己判断（首启没配 provider 就强制打开），恢复逻辑不掺和。
 */
export function currentViewState(): CenterViewState {
  const ui = useUiStore.getState();
  return {
    threadId: useThreadsStore.getState().currentThreadId,
    filePaths: ui.openFileTabs.map((t) => t.id),
    activeFilePath: ui.activeFileTabId,
    activeTab: ui.activeCenterTab === 'file' ? 'file' : 'thread',
  };
}

/**
 * 中央区一变就上报给主进程。
 *
 * 比的是快照本身而不是 store 引用：openFileTabs 里的 status / dirty / reloadNonce
 * 每次读盘都在动，照引用比会把这条 RPC 打成高频噪声，而那些字段根本不进快照。
 *
 * @returns 退订。生产里没人调（这两个订阅活到渲染进程结束为止），测试里必须调 ——
 *   zustand 的订阅是模块级的，留着会跨用例互相串。
 */
export function installViewStateSync(): () => void {
  let prev = JSON.stringify(currentViewState());
  const push = () => {
    const next = currentViewState();
    const key = JSON.stringify(next);
    if (key === prev) return;
    prev = key;
    void window.kydog.invoke('ui.saveViewState', { state: next })
      .catch((err) => console.error('persist view state failed', err));
  };
  const offThreads = useThreadsStore.subscribe(push);
  const offUi = useUiStore.subscribe(push);
  return () => { offThreads(); offUi(); };
}

/**
 * 把上一次的快照接回来。
 *
 * @param knownThreadIds 本次 bootstrap 带回来的 thread 全集。记着的那条可能已经被删了，
 *   不核对就会选中一个不存在的 thread，中央区落回欢迎页却还顶着一个选中态。
 * @param keepActiveTab true 表示别动 activeCenterTab —— 首启没配 provider 时 bootstrap
 *   已经把设置页顶到前面了，这里不该跟它抢。注意 openFile() 自带「切到 file 页」的副作用，
 *   所以最后那次 setState 必须把 activeCenterTab 显式写回去，不能只是「不去改它」。
 */
export function restoreViewState(
  vs: CenterViewState | null,
  knownThreadIds: Set<string>,
  keepActiveTab = false,
): void {
  if (!vs) return;
  const tabBefore = useUiStore.getState().activeCenterTab;

  for (const path of vs.filePaths) useUiStore.getState().openFile(path);
  if (vs.threadId && knownThreadIds.has(vs.threadId)) {
    useThreadsStore.getState().selectThread(vs.threadId);
  }

  const activeFilePath = vs.activeFilePath && vs.filePaths.includes(vs.activeFilePath)
    ? vs.activeFilePath
    : null;
  const wantFile = vs.activeTab === 'file' && activeFilePath !== null;
  useUiStore.setState({
    activeFileTabId: activeFilePath,
    activeCenterTab: keepActiveTab ? tabBefore : (wantFile ? 'file' : 'thread'),
  });
}
