/** 附件的分类与路径规则（spec §2.3、§3.3）。纯函数；图片编码的 DOM 部分在 imageData.ts。 */

export const SENDABLE_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_IMAGE_EDGE = 2000;
/** base64 之后的长度上限，与 pi 自带 resizeImage 同一个口径。 */
export const MAX_IMAGE_BASE64 = 4.5 * 1024 * 1024;
export const JPEG_QUALITIES = [0.85, 0.7, 0.55, 0.4] as const;

export type Classified = { kind: 'image'; path: string | null } | { kind: 'file'; path: string } | { kind: 'reject' };

/** `diskPath` 是 `pathForFile` 的结果：空串 = 磁盘上没有（Electron 给的事实，不猜）。 */
export function classifyFile(mimeType: string, diskPath: string): Classified {
  const path = diskPath === '' ? null : diskPath;
  if (SENDABLE_IMAGE_TYPES.includes(mimeType)) return { kind: 'image', path };
  if (path !== null) return { kind: 'file', path };
  return { kind: 'reject' };
}

function rootOf(projectPath: string): { root: string; sep: string } {
  const sep = projectPath.includes('\\') ? '\\' : '/';
  return { root: projectPath.endsWith(sep) ? projectPath.slice(0, -1) : projectPath, sep };
}

/** 发给 agent 的路径：在对话的项目里给相对路径（`/` 分隔），否则原样给绝对路径。 */
export function toMessagePath(absPath: string, projectPath: string): string {
  if (!projectPath) return absPath;
  const { root, sep } = rootOf(projectPath);
  if (!absPath.startsWith(root + sep)) return absPath;
  return absPath.slice(root.length + sep.length).split(/[\\/]/).join('/');
}

export function isInsideProject(absPath: string, projectPath: string): boolean {
  return toMessagePath(absPath, projectPath) !== absPath;
}

export function parentDirOf(absPath: string): string {
  const i = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'));
  if (i < 0) return '';
  return i === 0 ? absPath.slice(0, 1) : absPath.slice(0, i);
}

export function fitWithin(width: number, height: number, maxEdge = MAX_IMAGE_EDGE): { width: number; height: number; scaled: boolean } {
  const edge = Math.max(width, height);
  if (edge <= maxEdge) return { width, height, scaled: false };
  const k = maxEdge / edge;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), scaled: true };
}

export function base64Length(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}
