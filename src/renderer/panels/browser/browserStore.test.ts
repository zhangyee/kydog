import { describe, it, expect, beforeEach } from 'vitest';
import { useBrowserStore, agentBanner, NO_EPOCH } from './browserStore';
import type { BrowserTabInfo } from '../../../shared/types';

function reset() {
  useBrowserStore.setState({
    revision: -1, epoch: NO_EPOCH, tabs: [], activeTabId: null, agentTabs: new Map(),
  });
}

const tab = (id: string, patch: Partial<BrowserTabInfo> = {}): BrowserTabInfo => ({
  id, url: `https://${id}.example/`, title: id, loading: false,
  owner: 'user', canGoBack: false, canGoForward: false, viewportMode: 'fit', ...patch,
});

const S = () => useBrowserStore.getState();

describe('browserStore · 按 revision 去旧', () => {
  beforeEach(reset);

  it('更新的 revision 会改状态', () => {
    S().applyTabs({ revision: 3, tabs: [tab('t1')], activeTabId: 't1' });
    expect(S().revision).toBe(3);
    expect(S().tabs.map((t) => t.id)).toEqual(['t1']);
    expect(S().activeTabId).toBe('t1');
  });

  it('更旧的 revision 一个字段都不改', () => {
    S().applyTabs({ revision: 5, tabs: [tab('t1')], activeTabId: 't1' });
    S().applyTabs({ revision: 4, tabs: [tab('t9')], activeTabId: 't9' });
    expect(S().revision).toBe(5);
    expect(S().tabs.map((t) => t.id)).toEqual(['t1']);
    expect(S().activeTabId).toBe('t1');
  });

  it('相同的 revision 也不改 —— 「更新」是严格大于', () => {
    S().applyTabs({ revision: 5, tabs: [tab('t1')], activeTabId: 't1' });
    S().applyTabs({ revision: 5, tabs: [], activeTabId: null });
    expect(S().tabs.map((t) => t.id)).toEqual(['t1']);
  });

  it('第一帧 revision 0 收得下（初值是 -1，不是 0）', () => {
    S().applyTabs({ revision: 0, tabs: [tab('t1')], activeTabId: 't1' });
    expect(S().tabs).toHaveLength(1);
  });
});

/**
 * **这一组守的是本模块存在的理由。**
 *
 * `browser.getState` 的 handler 先 `newEpoch()`（推 revision + 广播一帧）再取快照，
 * 所以那一帧广播与 getState 的返回值**同 revision**，只是广播里没有 epoch。
 * 两者到达顺序没有保证：广播先到时，如果 epoch 跟 tabs 共用同一道 revision 闸，
 * 这一份 epoch 就被当旧帧丢了 —— `useStageBounds` 之后每一次 syncView 都会被主进程
 * 判为过期，侧栏里那块网页永远不可见，而且全程没有任何错误。
 */
describe('browserStore · epoch 与 revision 是两道独立的闸', () => {
  beforeEach(reset);

  it('快照那条路也把 tabs / activeTabId 接上（不是只接 epoch）', () => {
    // 第二轮变异 N5 是从这里活下来的：只断 epoch 的话，`applySnapshot` 把
    // `activeTabId` 写成 `cur.activeTabId` 照样全绿 —— 而那意味着重载之后
    // 侧栏永远选不中主进程说的那个活动标签。
    S().applySnapshot({ revision: 1, epoch: 1, tabs: [tab('t1'), tab('t2')], activeTabId: 't2' });
    expect(S().tabs.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(S().activeTabId).toBe('t2');
    expect(S().revision).toBe(1);
  });

  it('广播先到、快照后到且同 revision：tabs 不动，**epoch 照收**', () => {
    S().applyTabs({ revision: 7, tabs: [tab('t1')], activeTabId: 't1' });
    S().applySnapshot({ revision: 7, epoch: 3, tabs: [tab('t1')], activeTabId: 't1' });
    expect(S().revision).toBe(7);
    expect(S().epoch).toBe(3);
  });

  it('快照的 revision 更旧时 epoch 仍然照收', () => {
    S().applyTabs({ revision: 9, tabs: [tab('t9')], activeTabId: 't9' });
    S().applySnapshot({ revision: 2, epoch: 5, tabs: [], activeTabId: null });
    expect(S().epoch).toBe(5);
    expect(S().tabs.map((t) => t.id)).toEqual(['t9']);   // 旧的 tabs 没被打回去
  });

  it('epoch 只往大里走：迟到的旧快照不会把 epoch 拉回去', () => {
    S().applySnapshot({ revision: 1, epoch: 8, tabs: [], activeTabId: null });
    S().applySnapshot({ revision: 2, epoch: 6, tabs: [], activeTabId: null });
    expect(S().epoch).toBe(8);
  });

  it('广播永远不许碰 epoch —— 那是 getState 调用方专属的代号', () => {
    S().applySnapshot({ revision: 1, epoch: 4, tabs: [], activeTabId: null });
    S().applyTabs({ revision: 2, tabs: [tab('t1')], activeTabId: 't1' });
    expect(S().epoch).toBe(4);
  });

  it('还没 getState 过时 epoch 是 NO_EPOCH，不是某个碰巧能用的数', () => {
    expect(S().epoch).toBe(NO_EPOCH);
    S().applyTabs({ revision: 3, tabs: [tab('t1')], activeTabId: 't1' });
    expect(S().epoch).toBe(NO_EPOCH);
  });
});

describe('browserStore · agent 焦点', () => {
  beforeEach(reset);

  it('active:true 记下动作名，active:false 删掉', () => {
    S().applyAgentFocus({ tabId: 't1', active: true, action: '操作网页' });
    expect(S().agentTabs.get('t1')).toBe('操作网页');
    S().applyAgentFocus({ tabId: 't1', active: false });
    expect(S().agentTabs.has('t1')).toBe(false);
  });

  it('没带动作名时记 null（而不是 undefined 或者干脆不记）', () => {
    S().applyAgentFocus({ tabId: 't1', active: true });
    expect(S().agentTabs.has('t1')).toBe(true);
    expect(S().agentTabs.get('t1')).toBeNull();
  });

  /**
   * 主进程那边嵌套驱动会发两次 true、只发一次 false（先结束的那一帧不许熄灯，
   * `browserService.test.ts`「两帧握着同一个标签」那条）。当计数器用就会卡在亮着。
   */
  it('两次 true 一次 false 就该熄 —— 集合语义，不是计数器', () => {
    S().applyAgentFocus({ tabId: 't1', active: true, action: '内层' });
    S().applyAgentFocus({ tabId: 't1', active: true, action: '外层' });
    S().applyAgentFocus({ tabId: 't1', active: false });
    expect(S().agentTabs.has('t1')).toBe(false);
  });

  it('agent 焦点不推 revision —— 主进程那一侧也不推', () => {
    S().applyTabs({ revision: 4, tabs: [tab('t1')], activeTabId: 't1' });
    S().applyAgentFocus({ tabId: 't1', active: true });
    expect(S().revision).toBe(4);
  });

  it('tabId:null 一次把全部熄掉', () => {
    S().applyAgentFocus({ tabId: 't1', active: true });
    S().applyAgentFocus({ tabId: 't2', active: true });
    S().applyAgentFocus({ tabId: null, active: false });
    expect(S().agentTabs.size).toBe(0);
  });

  /**
   * 「标签在被驱动期间消失」那一支，主进程发不出熄灯信号
   *（`destroyView` 已经把它从驱动帧里摘掉，`withAgentDriving` 的 finally 遍历不到）。
   * **剪枝是那一支唯一的清除点。**
   */
  it('标签没了就把它的驱动记录一起剪掉（广播那条路）', () => {
    S().applyTabs({ revision: 1, tabs: [tab('t1'), tab('t2')], activeTabId: 't1' });
    S().applyAgentFocus({ tabId: 't1', active: true, action: '操作网页' });
    S().applyAgentFocus({ tabId: 't2', active: true, action: '读网页正文' });
    S().applyTabs({ revision: 2, tabs: [tab('t2')], activeTabId: 't2' });
    expect([...S().agentTabs.keys()]).toEqual(['t2']);
    expect(S().agentTabs.get('t2')).toBe('读网页正文');   // 活着的那条不许被顺手清掉
  });

  it('快照那条路也剪', () => {
    S().applyTabs({ revision: 1, tabs: [tab('t1')], activeTabId: 't1' });
    S().applyAgentFocus({ tabId: 't1', active: true });
    S().applySnapshot({ revision: 2, epoch: 1, tabs: [], activeTabId: null });
    expect(S().agentTabs.size).toBe(0);
  });

  it('被 revision 挡下的旧帧不许剪 —— 旧清单里没有的标签可能只是它太旧了', () => {
    S().applyTabs({ revision: 5, tabs: [tab('t1')], activeTabId: 't1' });
    S().applyAgentFocus({ tabId: 't1', active: true });
    S().applyTabs({ revision: 4, tabs: [], activeTabId: null });
    expect(S().agentTabs.has('t1')).toBe(true);
  });

  it('没有可剪的就保持同一个 Map 引用（否则每帧广播都会白重渲染一次）', () => {
    S().applyTabs({ revision: 1, tabs: [tab('t1')], activeTabId: 't1' });
    S().applyAgentFocus({ tabId: 't1', active: true });
    const before = S().agentTabs;
    S().applyTabs({ revision: 2, tabs: [tab('t1'), tab('t2')], activeTabId: 't1' });
    expect(S().agentTabs).toBe(before);
  });
});

describe('agentBanner：横幅只替「眼前这一页」说话', () => {
  beforeEach(reset);

  it('活动标签在被驱动 → 出横幅，带动作名', () => {
    expect(agentBanner({ activeTabId: 't1', agentTabs: new Map([['t1', '操作网页']]) }))
      .toEqual({ tabId: 't1', action: '操作网页' });
  });

  it('被驱动的是后台标签 → 不出横幅（那一个归标签条上的指示灯管）', () => {
    expect(agentBanner({ activeTabId: 't1', agentTabs: new Map([['t2', '操作网页']]) })).toBeNull();
  });

  it('没有动作名时 action 是 null，横幅照出', () => {
    expect(agentBanner({ activeTabId: 't1', agentTabs: new Map([['t1', null]]) }))
      .toEqual({ tabId: 't1', action: null });
  });

  it('一个标签都没有时不出', () => {
    expect(agentBanner({ activeTabId: null, agentTabs: new Map([['t1', 'x']]) })).toBeNull();
  });
});
