import type { App, BrowserWindow } from 'electron';

/**
 * 内置浏览器在主进程里的三处接线。
 *
 * **拆出来只为一件事：让它们能被用例碰到。** `main.ts` 里没有一行是单测够得着的，
 * 而这三处全都是「挂在哪个事件上」——接错既不会编译报错，也不会有任何用例红，
 * 只会悄悄不工作：
 *  · 漏 `attach` → 之后每一次开标签都报「还没装配到窗口上」；
 *  · 漏 `hideAll` → 渲染层重载那一瞬间原生 WebContentsView 继续按旧几何盖在新 UI 上；
 *  · 漏 `disposeAll` → 退出时标签不回收。
 */

/** 只声明这一层用得上的三个方法，替身不必去实现整个 BrowserService。 */
export type BrowserWiringPorts = {
  attach(win: BrowserWindow): void;
  hideAll(): void;
  disposeAll(): void;
};

/** `did-start-navigation` 那份 details 里这一层用得上的两个字段。 */
type NavDetails = { isMainFrame: boolean; isSameDocument: boolean };

/**
 * 把主窗口交给浏览器，并挂上「先藏起来」的两个触发点。
 *
 * 渲染层一开始重载，最后一次 `syncView` 就不再可靠（新的舞台还没量出来）；
 * 渲染进程没了更是再也不会有新的上报。这两个时刻都先 `hideAll()`，
 * 之后渲染层走「先订阅 → `browser.getState`（拿新 epoch）→ `syncView`」把它请回来。
 *
 * 判据用 `isMainFrame && !isSameDocument`，都是协议层现成的字段：
 * 子 frame 的导航不是渲染层在重载；`pushState` / hash 不换文档，UI 还在原地。
 *
 * **窗口 `closed` 不顺手 `disposeAll`**（裁决 2.3）：收摊只在 `before-quit` 做一次。
 * `BrowserService.attach` 自己挂的那个 `once('closed')` 只清窗口引用。
 */
export function installBrowserWindowWiring(win: BrowserWindow, svc: BrowserWiringPorts): void {
  svc.attach(win);
  win.webContents.on('did-start-navigation', (details: NavDetails) => {
    if (details.isMainFrame && !details.isSameDocument) svc.hideAll();
  });
  // 这个回调体内主窗口的渲染进程 pid 已经是 0（实测），所以此刻做布局是安全的。
  win.webContents.on('render-process-gone', () => { svc.hideAll(); });
}

/** 退出时收摊。`disposeAll` 幂等，跑第二遍时账本已经空了。 */
export function installBrowserQuitWiring(app: App, svc: BrowserWiringPorts): void {
  app.on('before-quit', () => { svc.disposeAll(); });
}
