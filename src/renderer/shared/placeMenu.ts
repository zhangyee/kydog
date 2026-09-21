/**
 * 右键菜单贴在指针处；放不下时右边往左挪到贴着边距、下边整个翻到指针上方。
 * 纯函数，`ContextMenu` 首帧量出自身尺寸后调它。
 */
export function placeMenu(
  at: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 8,
): { left: number; top: number } {
  let left = at.x;
  if (left + size.width > viewport.width - margin) left = Math.max(margin, viewport.width - margin - size.width);
  let top = at.y;
  if (top + size.height > viewport.height - margin) top = Math.max(margin, at.y - size.height);
  return { left, top };
}
