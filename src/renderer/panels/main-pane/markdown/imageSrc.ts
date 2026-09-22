/**
 * md 里图片地址 → 能加载的地址（spec 2026-09-22-md-export-pdf-design §2.6）。
 *
 * 为什么要它：Crepe 的 ImageBlock 不配 proxyDomURL 时，`![](figs/a.png)` 按**应用自己的页面地址**
 * 解析（打包版是 app.asar 里 index.html 所在的目录），永远载不到（2026-09-22 探针实测 naturalWidth 0）。
 * 这里按 md 所在目录解析成 file:// 地址。只影响显示：节点里存的 src 不变，保存回去的仍是原文。
 *
 * `..` 不设越界闸：这是显示一张本地图片，不是写入；用户自己的 md 引用上一级目录的图很正常。
 */
const WIN_DRIVE = /^[a-zA-Z]:[\\/]/;
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function fileUrl(absPath: string): string {
  const u = new URL('file:///');
  if (absPath.startsWith('\\\\')) {
    // UNC：\\server\share\a.png → file://server/share/a.png
    const [host, ...rest] = absPath.slice(2).split(/[\\/]/);
    u.host = host;
    u.pathname = `/${rest.join('/')}`;
    return u.href;
  }
  const posix = absPath.replace(/\\/g, '/');
  // pathname 的 setter 负责百分号编码（空格、中文、# 与 ?）
  u.pathname = WIN_DRIVE.test(absPath) ? `/${posix}` : posix;
  return u.href;
}

function dirUrlOf(mdPath: string): string {
  const cut = Math.max(mdPath.lastIndexOf('/'), mdPath.lastIndexOf('\\'));
  return fileUrl(`${mdPath.slice(0, cut + 1)}`);
}

export function resolveImageSrc(src: string, mdPath: string): string {
  if (src === '') return src;
  if (WIN_DRIVE.test(src) || src.startsWith('\\\\')) return fileUrl(src);
  if (HAS_SCHEME.test(src)) return src;
  if (src.startsWith('/')) return fileUrl(src);
  return new URL(src.replace(/\\/g, '/'), dirUrlOf(mdPath)).href;
}
