/**
 * 主窗口 `will-navigate` 的判定（纯函数，main.ts 接线）。
 *
 * 为什么不能按 origin 比：打包版的渲染层是 `loadFile` 出来的 `file://` 页面，而**任何** `file://`
 * 地址的 origin 都是字符串 `"null"`（`about:` / `data:` / `blob:` / `javascript:` 也是）。旧写法
 * `target.origin === current.origin` 因此会放行跳到任意本地 HTML —— 那个页面照样挂着 preload，
 * 拿到整个 `window.kydog` RPC。所以按协议分开判：
 *  - `file:`：只许同一个文档（主机 + 路径逐字相等，忽略 hash / query），别的本地文件一律不许；
 *  - `http:` / `https:`：只许与当前页同 origin（开发模式的 vite dev server）；
 *  - 其余协议一律不许。
 * 不许的里面，`http(s)` / `mailto` 交给系统浏览器 / 邮件客户端打开，其余什么都不做。
 *
 * 注意 Electron 的 `will-navigate` 只在页面自己发起的主 frame 跳转上触发：`webContents.reload()`
 * （Ctrl+R 菜单项）、`loadURL`、只改 hash 的页内跳转都不经过这里。同一文档照样放行只是保险。
 */
export type NavigationDecision = { allow: true } | { allow: false; openExternal: boolean };

const EXTERNAL = /^(https?|mailto):$/;

function parse(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}

export function decideNavigation(currentUrl: string, targetUrl: string): NavigationDecision {
  const target = parse(targetUrl);
  if (!target) return { allow: false, openExternal: false };
  const current = parse(currentUrl);
  const deny: NavigationDecision = { allow: false, openExternal: EXTERNAL.test(target.protocol) };
  if (!current) return deny;

  if (target.protocol === 'file:') {
    const sameDocument = current.protocol === 'file:'
      && current.host === target.host
      && current.pathname === target.pathname;
    return sameDocument ? { allow: true } : deny;
  }
  if (target.protocol === 'http:' || target.protocol === 'https:') {
    const sameOrigin = (current.protocol === 'http:' || current.protocol === 'https:')
      && current.origin === target.origin;
    return sameOrigin ? { allow: true } : deny;
  }
  return deny;
}
