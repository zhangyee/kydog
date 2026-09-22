/**
 * 选区工具栏各按钮的 hover 提示文案（Issue 1）。纯函数模块：不碰 DOM / window，
 * 平台作为参数传入，方便在 node 环境下不装 jsdom 也能测。
 *
 * key 对应 Crepe 内置工具栏项（`formatting` 组的 bold/italic/strikethrough，
 * `function` 组的 code/latex/link）以及 KyDog 自己加的 `comment`。
 */

/** Crepe 预设的快捷键：加粗 Mod-b，斜体 Mod-i，行内代码 Mod-e，删除线 Mod-Alt-x；公式/链接无快捷键。 */
const TIPS_DARWIN: Readonly<Record<string, string>> = {
  bold: '加粗 · ⌘B',
  italic: '斜体 · ⌘I',
  strikethrough: '删除线 · ⌘⌥X',
  code: '行内代码 · ⌘E',
  latex: '公式',
  link: '链接',
  // 功能整体叫「评论追问」，但这颗按钮的 tooltip 就叫「评论」（拍板见协调者更正）。
  comment: '评论',
};

const TIPS_OTHER: Readonly<Record<string, string>> = {
  ...TIPS_DARWIN,
  bold: '加粗 · Ctrl+B',
  italic: '斜体 · Ctrl+I',
  strikethrough: '删除线 · Ctrl+Alt+X',
  code: '行内代码 · Ctrl+E',
};

/** 按 key 取提示文案；key 不认识就返回 undefined（调用方跳过，不抛）。 */
export function toolbarTipFor(key: string, platform: string): string | undefined {
  const table = platform === 'darwin' ? TIPS_DARWIN : TIPS_OTHER;
  return table[key];
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/**
 * 把提示文案接到原图标 markup 后面，包一层 `.kydog-tb-tip`。DOMPurify（`Icon` 组件用它
 * sanitize）会保留 span + class，样式见 markdown-editor.css。原 icon markup 原样保留。
 */
export function appendToolbarTip(icon: string, tip: string): string {
  return `${icon}<span class="kydog-tb-tip">${escapeHtml(tip)}</span>`;
}
