/** 这次 blur 是不是「整个窗口失焦」造成的，而不是焦点移到了应用内别处。
 *
 *  切到别的应用时，浏览器同样会在当前输入框上派发 blur，但它**仍然是**
 *  document.activeElement —— 只是文档整体没有焦点了。把这种 blur 当成
 *  「用户编辑完了」会导致：用户切走再切回来，正在编辑的输入框已经消失。
 *  Finder、VS Code、浏览器地址栏都不会这样。
 *
 *  用在「失焦即提交」的就地编辑框上：`if (isWindowBlur()) return;`
 */
export function isWindowBlur(): boolean {
  return !document.hasFocus();
}
