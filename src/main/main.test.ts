import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * **`main.ts` 里那三处浏览器接线的守卫。**
 *
 * 最终评审 I1：把 `installBrowserWindowWiring` / `installBrowserQuitWiring` 连同 import
 * 一起删掉，`tsc` 退出 0、`lint` 退出 0（连 warning 都没有）、全部用例绿 —— 而产品行为是
 * 每一次 `browser.open` 都报「浏览器还没有装配到窗口上」，整个内置浏览器对用户完全不可用。
 * 拆出去的 `mainWiring.test.ts`（9 条）守的是「挂在哪个事件上」，守不了「main.ts 到底有
 * 没有调它」。
 *
 * 所以这份用例**真的把 `main.ts` 装配一遍**：替身掉它 import 的每一个重模块（都是启动期
 * 副作用，与浏览器无关），只留 `mainWiring` 与 `browserService` 是真身/探针，然后
 *
 *  1. 驱动 `app.on('ready')` → 断言 `attach` 收到的就是**这次造出来的那个窗口**；
 *  2. 往那个窗口自己的 webContents 上打一次真实的 `did-start-navigation` → 断言 `hideAll`；
 *  3. 触发 `before-quit` → 断言 `disposeAll`。
 *
 * 断言的是**装配之后可观测的副作用**，不是「源码里有没有那一行」：删掉调用（或删掉整个
 * import）这三条各自红，接错窗口、挂错事件也红。
 */

const TMP = mkdtempSync(path.join(os.tmpdir(), 'kydog-main-'));

const H = vi.hoisted(() => {
  type Fn = (...args: unknown[]) => unknown;

  /** 一个够用的 webContents 替身：只记监听器，让用例扮演 Chromium 打事件进来。 */
  class FakeWebContents {
    listeners: Record<string, Fn[]> = {};
    openedDevTools = 0;
    /** 当前页地址：缺省是 dev-server；will-navigate 那组用例临时换成打包版的 file://。 */
    url = 'http://localhost:5173/';
    on(event: string, fn: Fn) { (this.listeners[event] ??= []).push(fn); return this; }
    once(event: string, fn: Fn) { return this.on(event, fn); }
    setWindowOpenHandler(_fn: Fn) { /* main.ts 的外链策略，本文件不考 */ }
    openDevTools() { this.openedDevTools += 1; }
    getURL() { return this.url; }
    send() { /* 广播出口已替身 */ }
    isDestroyed() { return false; }
    fire(event: string, ...args: unknown[]) {
      const fns = this.listeners[event] ?? [];
      if (!fns.length) throw new Error(`没有人监听 ${event}`);
      for (const fn of fns) fn(...args);
      return fns.length;
    }
  }

  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    webContents = new FakeWebContents();
    listeners: Record<string, Fn[]> = {};
    constructor(public opts: unknown) { FakeBrowserWindow.instances.push(this); }
    on(event: string, fn: Fn) { (this.listeners[event] ??= []).push(fn); return this; }
    once(event: string, fn: Fn) { return this.on(event, fn); }
    async loadURL() { /* dev-server 分支 */ }
    async loadFile() { /* 打包分支 */ }
    isDestroyed() { return false; }
    fire(event: string, ...args: unknown[]) {
      const fns = this.listeners[event] ?? [];
      for (const fn of fns) fn(...args);
      return fns.length;
    }
    static getAllWindows() { return FakeBrowserWindow.instances; }
  }

  const appListeners: Record<string, Fn[]> = {};
  const app = {
    // isPackaged=true 只为跳过 main.ts 里那个分离 DevTools 窗口的分支（那是 dev 专用）。
    isPackaged: true,
    dock: undefined as unknown,
    quit: vi.fn(),
    on(event: string, fn: Fn) { (appListeners[event] ??= []).push(fn); return app; },
    getVersion: () => '0.0.0-test',
    getLocale: () => 'zh-CN',
  };

  /** 浏览器侧的探针：只要 main.ts 那三行还在，这三个就会被真的调到。 */
  const browser = {
    attached: [] as unknown[],
    hideAll: 0,
    disposeAll: 0,
  };

  const errors: Array<{ scope: string; msg: string }> = [];

  /** 启动期的调用次序：只记那几个「谁先谁后有后果」的点。 */
  const order: string[] = [];
  /** installProxyDispatcher 收到的 deps，用来验它接的是不是 Chromium 那个解析器。 */
  const proxyDeps: Array<{ resolveProxy: (url: string) => Promise<string> }> = [];

  return { FakeWebContents, FakeBrowserWindow, app, appListeners, browser, errors, order, proxyDeps };
});

vi.mock('electron', () => ({
  app: H.app,
  BrowserWindow: H.FakeBrowserWindow,
  dialog: { showMessageBoxSync: vi.fn(), showErrorBox: vi.fn() },
  nativeImage: { createFromDataURL: (u: string) => ({ dataUrl: u }) },
  shell: { openExternal: vi.fn() },
  // 可辨认的返回值：用来断 main.ts 接的确实是 Chromium 的解析器，而不是别的什么东西。
  session: { defaultSession: { resolveProxy: async (url: string) => `PROXY chromium-said:${url}` } },
}));
vi.mock('electron-squirrel-startup', () => ({ default: false }));

// ── main.ts 启动期那一长串副作用，与浏览器接线无关，全部替身 ──────────────────
vi.mock('./persist/paths', () => ({
  ROOT: TMP,
  SESSIONS_DIR: path.join(TMP, 'sessions'),
  LOGS_DIR: path.join(TMP, 'logs'),
  STAGING_DIR: path.join(TMP, 'staging'),
}));
vi.mock('./log', () => ({
  logger: {
    debug: () => {}, info: () => {},
    warn: () => {},
    error: (scope: string, msg: string) => { H.errors.push({ scope, msg }); },
  },
}));
vi.mock('./ipc/dispatcher', () => ({ installDispatcher: vi.fn() }));
vi.mock('./handlers', () => ({ registerAllHandlers: vi.fn() }));
vi.mock('./windowChrome', () => ({ windowChrome: () => ({}) }));
vi.mock('./menu', () => ({ installAppMenu: vi.fn() }));
vi.mock('./bin/binPath', () => ({ binDir: () => path.join(TMP, 'bin') }));
vi.mock('./bin/pathEnv', () => ({ prependBinDirToPath: vi.fn() }));
vi.mock('./bin/shellCheck', () => ({ detectBashOnWindows: () => ({ found: true, searched: [] }) }));
vi.mock('./skills/skillSyncStateHolder', () => ({ skillSyncStateHolder: { runFor: vi.fn(async () => {}) } }));
vi.mock('./settings/settingsService', () => ({
  settingsService: {
    get: async () => ({
      llm: { providers: {} },
      research: {},
      ui: { locale: 'zh' },
      tools: { externalBins: [] },
      telemetry: { state: 'undecided', decidedAt: null },
      // 未完成 onboarding：跳过 skill 同步那一段，与浏览器接线无关。
      onboarding: { completedAt: null },
    }),
  },
}));
vi.mock('./persist/settingsFile', () => ({ ensureSettingsFile: vi.fn() }));
vi.mock('./llm/cloudEnvSync', () => ({ applyCloudEnv: vi.fn() }));
vi.mock('./research/researchEnv', () => ({ applyResearchEnv: vi.fn() }));
vi.mock('./llm/providerRegistry', () => ({
  initProviderRegistry: vi.fn(async () => { H.order.push('providerRegistry'); }),
  setCatalogRefreshedHook: vi.fn(),
}));
vi.mock('./net/systemProxy', () => ({
  installProxyDispatcher: (deps: { resolveProxy: (url: string) => Promise<string> }) => {
    H.order.push('proxy');
    H.proxyDeps.push(deps);
    return () => {};
  },
}));
vi.mock('./llm/llmService', () => ({ llmService: { list: async () => ({}) } }));
vi.mock('./project/fileWatcher', () => ({ fileWatcherService: { stopAll: async () => {} } }));
vi.mock('./pdf/pdfRaster', () => ({ destroyRasterWindow: vi.fn() }));
vi.mock('./harness/identityService', () => ({ startIdentityWatcher: vi.fn() }));
vi.mock('./update/assemble', () => ({ initUpdateService: vi.fn(async () => {}) }));
vi.mock('./telemetry/assemble', () => ({ assembleTelemetry: vi.fn() }));
vi.mock('./ipc/broadcaster', () => ({ broadcaster: { emit: vi.fn() } }));

/**
 * **只有这一个不替身成空壳**：真的那个 `browserService` import 了 electron 的
 * `WebContentsView` / `session`，本文件的 electron 替身里没有。换成探针，
 * 三处接线各自的可观测副作用就落在这三个计数上。
 * `mainWiring` 用**真身**，不然守的就是替身自己。
 */
vi.mock('./browser/browserService', () => ({
  browserService: {
    attach: (win: unknown) => { H.browser.attached.push(win); },
    hideAll: () => { H.browser.hideAll += 1; },
    disposeAll: () => { H.browser.disposeAll += 1; },
  },
}));

type FakeWin = InstanceType<typeof H.FakeBrowserWindow>;

let win: FakeWin;

beforeAll(async () => {
  // forge 的 vite 插件在构建期把这两个 define 进去；单测里它们是自由标识符，
  // 不给就是 ReferenceError。走 dev-server 分支（loadURL），免得碰 __dirname 拼路径。
  vi.stubGlobal('MAIN_WINDOW_VITE_DEV_SERVER_URL', 'http://localhost:5173/');
  vi.stubGlobal('MAIN_WINDOW_VITE_NAME', 'main_window');

  await import('./main');

  const ready = H.appListeners['ready'];
  expect(ready, 'main.ts 没有挂 app.on(ready)').toHaveLength(1);
  await ready[0]();

  // 启动失败会被 main.ts 那个 try/catch 吞成一条 error 日志 —— 不看这一眼，
  // 下面所有断言红起来都指向错误的地方。
  expect(H.errors, '启动过程中报了错').toEqual([]);
  expect(H.FakeBrowserWindow.instances).toHaveLength(1);
  win = H.FakeBrowserWindow.instances[0];
});

afterAll(() => { vi.unstubAllGlobals(); rmSync(TMP, { recursive: true, force: true }); });

/**
 * **出网路径的守卫。** 失败形态是静默的：把 `installProxyDispatcher` 整行删掉、或者挪到
 * `initProviderRegistry` 后面，`tsc` / `lint` / 其余用例全绿，而产品行为是主进程的请求
 * （至少是启动最早那批）绕过系统代理直连出去——国内用户又退回「只有 Tun 模式才能用」。
 * `systemProxy.test.ts` 守的是这个模块**自己**对不对，守不了 main.ts 到底调没调、排在哪。
 */
describe('main.ts 把出网路径接到了 Chromium 的代理解析器上', () => {
  it('装了，而且排在 initProviderRegistry 之前', () => {
    // 排序是有后果的：registry 构造完就会飞一次不 await 的后台目录刷新（见 llm-architecture §3），
    // 那是启动后最早的一批请求；挪到它后面，那批就漏掉代理了。
    expect(H.order).toContain('proxy');
    expect(H.order).toContain('providerRegistry');
    expect(H.order.indexOf('proxy')).toBeLessThan(H.order.indexOf('providerRegistry'));
  });

  it('传进去的 resolveProxy 就是 session.defaultSession.resolveProxy，不是别的', async () => {
    expect(H.proxyDeps).toHaveLength(1);
    // 接错对象（比如自己读环境变量、或者写死 DIRECT）时这里拿不到这个可辨认的返回值。
    await expect(H.proxyDeps[0].resolveProxy('https://auth.openai.com'))
      .resolves.toBe('PROXY chromium-said:https://auth.openai.com');
  });
});

describe('main.ts 真的把内置浏览器装配起来了', () => {
  it('窗口造出来之后 attach 收到的就是这一个窗口', () => {
    // 删掉 installBrowserWindowWiring 这一行 → 这里红。
    expect(H.browser.attached).toEqual([win]);
  });

  it('这个窗口自己的 did-start-navigation（渲染层重载）会把网页藏起来', () => {
    const before = H.browser.hideAll;
    // 挂到别的窗口 / 挂错事件，这一发就打不进来（fire 会抛「没有人监听」）。
    win.webContents.fire('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(H.browser.hideAll).toBe(before + 1);
  });

  it('子 frame / 同文档导航不藏 —— 判据接的是真的那两个字段', () => {
    const before = H.browser.hideAll;
    win.webContents.fire('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    win.webContents.fire('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(H.browser.hideAll).toBe(before);
  });

  it('渲染进程没了也藏起来', () => {
    const before = H.browser.hideAll;
    win.webContents.fire('render-process-gone');
    expect(H.browser.hideAll).toBe(before + 1);
  });

  it('窗口 closed 不收摊（裁决 2.3）—— 收摊只在退出时做一次', () => {
    const before = H.browser.disposeAll;
    win.fire('closed');
    expect(H.browser.disposeAll).toBe(before);
  });

  it('before-quit 收摊', () => {
    const before = H.browser.disposeAll;
    // 删掉 installBrowserQuitWiring 这一行 → 这里红（before-quit 上就只剩 main.ts
    // 自己那个关文件监听 / 销毁 PDF 渲染窗口的回调）。
    for (const fn of H.appListeners['before-quit'] ?? []) fn();
    expect(H.browser.disposeAll).toBe(before + 1);
  });
});

describe('最后一个窗口关闭后的应用生命周期', () => {
  it('darwin 不 quit；win32/linux quit', () => {
    const before = H.app.quit.mock.calls.length;
    for (const fn of H.appListeners['window-all-closed'] ?? []) fn();
    const delta = H.app.quit.mock.calls.length - before;
    expect(delta).toBe(process.platform === 'darwin' ? 0 : 1);
  });
});

/**
 * **主窗口导航守卫的接线。** 判定本身在 `navigationGuard.test.ts`；这里守的是 main.ts 真的把
 * `will-navigate` 接到了它上面，并且按判定结果 `preventDefault` / 交给系统打开。旧写法按 origin
 * 比，而任何 file:// 的 origin 都是 "null" —— 打包版里跳到任意本地 HTML 都会被放行，那个页面照样
 * 拿到 preload 的 window.kydog。
 */
describe('main.ts 的 will-navigate 守卫', () => {
  const APP = 'file:///app/.vite/renderer/main_window/index.html';

  it('打包版：别的本地文件拦下且不交给系统；同一文档（只差 hash）放行；https 拦下并交给系统', async () => {
    const { shell } = await import('electron');
    const openExternal = vi.mocked(shell.openExternal);
    openExternal.mockClear();
    win.webContents.url = APP;
    try {
      const evil = { preventDefault: vi.fn() };
      win.webContents.fire('will-navigate', evil, 'file:///etc/evil.html');
      expect(evil.preventDefault).toHaveBeenCalledTimes(1);

      const same = { preventDefault: vi.fn() };
      win.webContents.fire('will-navigate', same, `${APP}#/settings`);
      expect(same.preventDefault).not.toHaveBeenCalled();

      const ext = { preventDefault: vi.fn() };
      win.webContents.fire('will-navigate', ext, 'https://example.com/');
      expect(ext.preventDefault).toHaveBeenCalledTimes(1);
      // 只有 https 那一发交给了系统：evil 那一发（本地文件）没有。
      expect(openExternal.mock.calls).toEqual([['https://example.com/']]);
    } finally {
      win.webContents.url = 'http://localhost:5173/';
    }
  });
});
