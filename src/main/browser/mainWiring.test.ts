import { describe, it, expect, beforeEach } from 'vitest';
import {
  installBrowserWindowWiring, installBrowserQuitWiring,
  type BrowserWiringPorts,
} from './mainWiring';

/**
 * 主进程那三处接线。**它们全是「挂在哪个事件上」，接错不会编译报错、不会有任何
 * 用例红，只会悄悄不工作**：
 *  · 忘了 `attach` → 之后每一次开标签都报「还没装配到窗口上」；
 *  · 忘了 `hideAll` → 渲染层重载那一瞬间原生 WebContentsView 还盖在新 UI 上；
 *  · 忘了 `disposeAll` → 退出时标签不回收。
 * 所以这层从 main.ts 里拆出来：main.ts 里没有一行是能被单测碰到的。
 */

type Handler = (...args: never[]) => void;

class FakeEmitter {
  readonly handlers = new Map<string, Handler[]>();
  on(ev: string, fn: Handler): this {
    const list = this.handlers.get(ev) ?? [];
    list.push(fn);
    this.handlers.set(ev, list);
    return this;
  }
  fire(ev: string, ...args: unknown[]): void {
    for (const fn of [...(this.handlers.get(ev) ?? [])]) (fn as (...a: unknown[]) => void)(...args);
  }
  count(ev: string): number { return (this.handlers.get(ev) ?? []).length; }
}

class FakeWindow {
  readonly webContents = new FakeEmitter();
}

function ports() {
  const calls: string[] = [];
  const attached: unknown[] = [];
  const svc: BrowserWiringPorts = {
    attach: (w) => { calls.push('attach'); attached.push(w); },
    hideAll: () => { calls.push('hideAll'); },
    disposeAll: () => { calls.push('disposeAll'); },
  };
  return { svc, calls, attached };
}

let p: ReturnType<typeof ports>;
beforeEach(() => { p = ports(); });

describe('窗口接线', () => {
  it('装配时就把窗口交给 browserService —— 而且是这一个窗口', () => {
    const win = new FakeWindow();
    installBrowserWindowWiring(win as never, p.svc);
    expect(p.calls).toEqual(['attach']);
    expect(p.attached).toEqual([win]);
  });

  /**
   * 渲染层一开始重载，最后一次 syncView 就不可靠了（新的舞台还没量出来）。
   * 不先藏起来，原生层会继续按旧几何盖在正在重建的 UI 上。
   * 重载之后渲染层会走「先订阅、后 getState（拿新 epoch）、再 syncView」把它请回来。
   */
  it('主 frame 跨文档导航（= 渲染层重载）→ hideAll', () => {
    const win = new FakeWindow();
    installBrowserWindowWiring(win as never, p.svc);
    win.webContents.fire('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(p.calls).toEqual(['attach', 'hideAll']);
  });

  it('子 frame 的导航不藏 —— 那不是渲染层在重载', () => {
    const win = new FakeWindow();
    installBrowserWindowWiring(win as never, p.svc);
    win.webContents.fire('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    expect(p.calls).toEqual(['attach']);
  });

  it('同文档导航不藏 —— pushState / hash 不换文档，UI 还在那儿', () => {
    const win = new FakeWindow();
    installBrowserWindowWiring(win as never, p.svc);
    win.webContents.fire('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(p.calls).toEqual(['attach']);
  });

  it('渲染进程没了 → hideAll', () => {
    const win = new FakeWindow();
    installBrowserWindowWiring(win as never, p.svc);
    win.webContents.fire('render-process-gone', {}, { reason: 'crashed' });
    expect(p.calls).toEqual(['attach', 'hideAll']);
  });

  /** 窗口关掉**不**顺手 disposeAll（裁决 2.3）：只在 before-quit 收一次。 */
  it('窗口这一路一次都不 disposeAll', () => {
    const win = new FakeWindow();
    installBrowserWindowWiring(win as never, p.svc);
    win.webContents.fire('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    win.webContents.fire('render-process-gone', {}, { reason: 'crashed' });
    expect(p.calls).not.toContain('disposeAll');
  });

  it('两个触发点各挂一个，不是同一个事件挂两遍', () => {
    const win = new FakeWindow();
    installBrowserWindowWiring(win as never, p.svc);
    expect(win.webContents.count('did-start-navigation')).toBe(1);
    expect(win.webContents.count('render-process-gone')).toBe(1);
  });
});

describe('退出接线', () => {
  it('before-quit 时收摊', () => {
    const app = new FakeEmitter();
    installBrowserQuitWiring(app as never, p.svc);
    expect(p.calls).toEqual([]);          // 装配那一刻什么都不做
    app.fire('before-quit');
    expect(p.calls).toEqual(['disposeAll']);
  });

  /** `disposeAll` 自己是幂等的，但挂错成 `window-all-closed` 之类就会提前收摊。 */
  it('挂的是 before-quit，不是别的退出信号', () => {
    const app = new FakeEmitter();
    installBrowserQuitWiring(app as never, p.svc);
    expect(app.count('before-quit')).toBe(1);
    app.fire('window-all-closed');
    app.fire('quit');
    expect(p.calls).toEqual([]);
  });
});
