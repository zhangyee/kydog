import { describe, it, expect, vi } from 'vitest';
import { installBrowserBridge, type BrowserBridgePorts, type BrowserSink } from './browserBridge';
import type { BrowserState, BrowserTabInfo } from '../../../shared/types';
import type { EventPayload, EventTopic } from '../../../shared/protocol';

const tab = (id: string): BrowserTabInfo => ({
  id, url: `https://${id}.example/`, title: id, loading: false,
  owner: 'user', canGoBack: false, canGoForward: false,
});

const STATE: BrowserState = { revision: 4, epoch: 2, tabs: [tab('t1')], activeTabId: 't1' };

function harness(opts: { state?: Promise<BrowserState> } = {}) {
  /** 每一步按发生顺序记一笔 —— 恢复协议要守的正是**顺序**，不是「都调过了」。 */
  const order: string[] = [];
  const listeners = new Map<string, (p: never) => void>();
  const sink: BrowserSink = {
    applySnapshot: vi.fn(() => { order.push('applySnapshot'); }),
    applyTabs: vi.fn(() => { order.push('applyTabs'); }),
    applyAgentFocus: vi.fn(() => { order.push('applyAgentFocus'); }),
  };
  const bridge: BrowserBridgePorts = {
    on: (<T extends EventTopic>(topic: T, fn: (p: EventPayload<T>) => void) => {
      order.push(`on:${topic}`);
      listeners.set(topic, fn as (p: never) => void);
      return () => {};
    }) as BrowserBridgePorts['on'],
    invoke: vi.fn(() => {
      order.push('invoke:browser.getState');
      return opts.state ?? Promise.resolve(STATE);
    }),
  };
  const fire = <T extends EventTopic>(topic: T, payload: EventPayload<T>) => {
    const fn = listeners.get(topic);
    if (!fn) throw new Error(`没人订阅 ${topic}`);
    (fn as (p: EventPayload<T>) => void)(payload);
  };
  return { order, sink, bridge, fire, listeners };
}

/**
 * 第二轮变异实测：把 `getState` 挪到订阅之前、或把两条订阅改成空函数，
 * `tsc` / `lint` / `npm test` **三条全绿**（N14 / N15 / N16）。这一组就是那三条的闸。
 */
describe('installBrowserBridge · 恢复协议的顺序', () => {
  it('两条订阅都在 getState **之前**', () => {
    const h = harness();
    installBrowserBridge(h.bridge, h.sink);
    const iTabs = h.order.indexOf('on:browser.tabsChanged');
    const iFocus = h.order.indexOf('on:browser.agentFocus');
    const iGet = h.order.indexOf('invoke:browser.getState');
    expect(iTabs).toBeGreaterThanOrEqual(0);
    expect(iFocus).toBeGreaterThanOrEqual(0);
    expect(iGet).toBeGreaterThanOrEqual(0);
    expect(iTabs).toBeLessThan(iGet);
    expect(iFocus).toBeLessThan(iGet);
  });

  it('getState 真的调了一次 —— 只订阅不取快照，重载后镜像会一直是空的', () => {
    const h = harness();
    installBrowserBridge(h.bridge, h.sink);
    expect(h.bridge.invoke).toHaveBeenCalledTimes(1);
    expect(h.bridge.invoke).toHaveBeenCalledWith('browser.getState');
  });

  it('快照回来之后落进 applySnapshot（epoch 只有这一条路进得来）', async () => {
    const h = harness();
    installBrowserBridge(h.bridge, h.sink);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sink.applySnapshot).toHaveBeenCalledWith(STATE);
  });

  it('getState 失败不掀翻调用方（侧栏空着，别的照常）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ state: Promise.reject(new Error('boom')) });
    expect(() => installBrowserBridge(h.bridge, h.sink)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sink.applySnapshot).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('installBrowserBridge · 两条广播各接各的', () => {
  it('browser.tabsChanged → applyTabs，载荷原样', () => {
    const h = harness();
    installBrowserBridge(h.bridge, h.sink);
    const snap = { revision: 9, tabs: [tab('t7')], activeTabId: 't7' };
    h.fire('browser.tabsChanged', snap);
    expect(h.sink.applyTabs).toHaveBeenCalledWith(snap);
    expect(h.sink.applyAgentFocus).not.toHaveBeenCalled();
  });

  it('browser.agentFocus → applyAgentFocus，载荷原样', () => {
    const h = harness();
    installBrowserBridge(h.bridge, h.sink);
    const focus = { tabId: 't1', active: true, action: '操作网页' };
    h.fire('browser.agentFocus', focus);
    expect(h.sink.applyAgentFocus).toHaveBeenCalledWith(focus);
    expect(h.sink.applyTabs).not.toHaveBeenCalled();
  });

  /** 两条接反了的话，上面两条各自还是「调到了一个函数」—— 这条钉住它们没接反。 */
  it('两条互不串台', () => {
    const h = harness();
    installBrowserBridge(h.bridge, h.sink);
    h.fire('browser.tabsChanged', { revision: 1, tabs: [], activeTabId: null });
    h.fire('browser.agentFocus', { tabId: 't1', active: false });
    expect(h.sink.applyTabs).toHaveBeenCalledTimes(1);
    expect(h.sink.applyAgentFocus).toHaveBeenCalledTimes(1);
  });

  it('只订阅了这两条，没有多订也没有少订', () => {
    const h = harness();
    installBrowserBridge(h.bridge, h.sink);
    expect([...h.listeners.keys()].sort()).toEqual(['browser.agentFocus', 'browser.tabsChanged']);
  });
});
