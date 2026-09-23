/** macOS 的应用与窗口生命周期分离；其余平台最后一个窗口关闭即结束应用。 */
export function shouldQuitAfterAllWindowsClosed(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin';
}
