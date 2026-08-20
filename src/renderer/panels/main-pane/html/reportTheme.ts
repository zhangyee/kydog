/**
 * 报告 iframe 的主题转发。
 *
 * CSS 自定义属性不跨 iframe 边界继承，`prefers-color-scheme` 又对不上 KyDog 的
 * 五套具名配色，所以只能把宿主当前的计算值注入进去。报告模板一律写
 * `var(--ink, #2a2620)` 这种带 fallback 的形态 —— app 里跟随主题，
 * 用浏览器单独打开时走 fallback，两边都成立。
 */

/** 转发给报告的变量。清单由 reportTheme.test.ts 与 vellum.css 锁死。 */
export const HOST_THEME_VARS = [
  '--paper', '--paper-deep', '--paper-edge',
  '--ink', '--ink-soft', '--ink-faint', '--ink-hair', '--ink-hair-soft',
  '--accent', '--accent-soft', '--accent-hover',
  '--marginalia', '--moss', '--amber',
  '--font-serif', '--font-sans', '--font-mono',
] as const;

/**
 * 有意不转发的：这些是 app 外壳专用，报告里没有对应的东西。
 * 加新 token 时必须在这两个清单之一里登记，否则 reportTheme.test.ts 会红。
 */
export const NOT_FORWARDED_VARS = [
  '--grain-color', '--grain-size', '--grain-opacity',     // 窗口底纹
  '--titlebar-bg-from', '--titlebar-bg-to', '--titlebar-text',
  '--card-shadow', '--card-shadow-strong',
  '--hover-bg',
] as const;

/** 阅读字号，由 globals.css 的 :root[data-reading-size] 声明，不在各主题文件里。 */
export const HOST_SIZE_VARS = ['--reading-font-size', '--reading-line-height'] as const;

export function buildHostThemeCss(read: (name: string) => string): string {
  const lines: string[] = [];
  for (const name of [...HOST_THEME_VARS, ...HOST_SIZE_VARS]) {
    const value = read(name).trim();
    if (value === '') continue; // 宿主没定义 → 让报告走自己的 fallback
    lines.push(`  ${name}: ${value};`);
  }
  return `:root {\n${lines.join('\n')}\n}`;
}

/**
 * 把主题变量注入报告的 <head>。
 *
 * 用 DOMParser 而不是找 `</head>` 插字符串：后者在报告结构稍有变化时会静默失败
 * （没有 head 标签、head 出现在注释里、大小写不同）。DOMParser 产出的是惰性
 * document —— 不执行脚本、不加载资源。
 *
 * 只在渲染进程可用（vitest 是 node 环境，没有 DOMParser），因此本函数由 e2e 覆盖。
 */
export function injectHostTheme(html: string, css: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // srcdoc 文档的 base URL 继承自宿主，导致 href="#x" 解析成 <宿主URL>#x，
  // 被当成跨文档导航 —— 页内锚点会失效（file:// 下静默无效，http 下把 frame
  // 导航到宿主页面）。钉死 base 才能让 #锚点 成为同文档片段导航。
  // 顺带把任意来路 .html 里的相对 URL 也钉在 about:srcdoc 上，它们本来会
  // 解析到宿主页面路径，既没用又是一次多余的本地请求。
  if (!doc.querySelector('base')) {
    const base = doc.createElement('base');
    base.href = 'about:srcdoc';
    doc.head.prepend(base);
  }

  const style = doc.createElement('style');
  style.id = 'kydog-host-theme';
  style.textContent = css;
  doc.head.append(style);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

/** 从宿主根元素读一个自定义属性的计算值。 */
export function readHostVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}
