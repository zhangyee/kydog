import { describe, it, expect } from 'vitest';
import { decideNavigation } from './navigationGuard';

const APP = 'file:///Applications/KyDog.app/Contents/Resources/app.asar/.vite/renderer/main_window/index.html';
const DEV = 'http://localhost:5173/';

describe('decideNavigation —— 打包版（file://）', () => {
  it('复现旧判据的漏洞：任意两个 file:// 的 origin 都是 "null"，按 origin 比就会放行别的本地文件', () => {
    // 这就是 main.ts 里旧写法 `target.origin === current.origin` 的前提：它对 file:// 恒成立。
    expect(new URL(APP).origin).toBe('null');
    expect(new URL('file:///etc/evil.html').origin).toBe(new URL(APP).origin);
    // 新判据：同一文档放行（正向），换一个本地文件就拦下，且不交给系统打开。
    expect(decideNavigation(APP, APP)).toEqual({ allow: true });
    expect(decideNavigation(APP, 'file:///etc/evil.html')).toEqual({ allow: false, openExternal: false });
  });

  it('同一文档只差 hash / query：放行；同目录下别的文件、上一级目录：拦下', () => {
    expect(decideNavigation(APP, `${APP}#/settings`)).toEqual({ allow: true });
    expect(decideNavigation(APP, `${APP}?x=1`)).toEqual({ allow: true });
    const sibling = APP.replace('index.html', 'other.html');
    expect(decideNavigation(APP, sibling)).toEqual({ allow: false, openExternal: false });
    expect(decideNavigation(APP, APP.replace('main_window/index.html', 'index.html'))).toEqual({ allow: false, openExternal: false });
  });

  it('Windows 盘符路径与 UNC 主机：同一文档放行；换盘、换主机拦下', () => {
    const win = 'file:///C:/Program%20Files/KyDog/resources/app.asar/.vite/renderer/main_window/index.html';
    expect(decideNavigation(win, `${win}#x`)).toEqual({ allow: true });
    expect(decideNavigation(win, 'file:///D:/x/index.html')).toEqual({ allow: false, openExternal: false });
    const unc = 'file://server/share/app/index.html';
    expect(decideNavigation(unc, unc)).toEqual({ allow: true });
    expect(decideNavigation(unc, 'file://other/share/app/index.html')).toEqual({ allow: false, openExternal: false });
  });

  it('origin 同样是 "null" 的 about: / data: / blob: / javascript:：一律拦下、不交给系统', () => {
    expect(decideNavigation(APP, APP)).toEqual({ allow: true });
    for (const t of ['about:blank', 'data:text/html,<p>x</p>', `blob:${APP}`, 'javascript:alert(1)']) {
      expect(new URL(t).origin, t).toBe('null');
      expect(decideNavigation(APP, t), t).toEqual({ allow: false, openExternal: false });
    }
  });

  it('http(s) / mailto：拦下，交给系统浏览器 / 邮件客户端', () => {
    expect(decideNavigation(APP, 'https://example.com/a')).toEqual({ allow: false, openExternal: true });
    expect(decideNavigation(APP, 'http://example.com/')).toEqual({ allow: false, openExternal: true });
    expect(decideNavigation(APP, 'mailto:a@b.c')).toEqual({ allow: false, openExternal: true });
  });
});

describe('decideNavigation —— 开发模式（vite dev server）', () => {
  it('同 origin 放行（HMR 整页刷新、页内跳转）；别的 origin 拦下并交给系统', () => {
    expect(decideNavigation(DEV, 'http://localhost:5173/src/x')).toEqual({ allow: true });
    expect(decideNavigation(DEV, 'http://localhost:9999/')).toEqual({ allow: false, openExternal: true });
    expect(decideNavigation(DEV, 'https://localhost:5173/')).toEqual({ allow: false, openExternal: true });
  });

  it('开发模式下跳到本地文件：拦下、不交给系统', () => {
    expect(decideNavigation(DEV, 'http://localhost:5173/')).toEqual({ allow: true });
    expect(decideNavigation(DEV, 'file:///etc/evil.html')).toEqual({ allow: false, openExternal: false });
  });
});

describe('decideNavigation —— 解析不了的地址', () => {
  it('目标或当前地址解析失败：拦下，不交给系统', () => {
    expect(decideNavigation(APP, APP)).toEqual({ allow: true });
    expect(decideNavigation(APP, 'not a url')).toEqual({ allow: false, openExternal: false });
    expect(decideNavigation('', 'https://example.com/')).toEqual({ allow: false, openExternal: true });
    expect(decideNavigation('', 'file:///etc/evil.html')).toEqual({ allow: false, openExternal: false });
  });
});
