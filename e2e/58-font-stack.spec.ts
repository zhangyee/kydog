import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings, type LaunchedApp } from './helpers';

/** 打进产物的五个家族，键是 @font-face 的**注册名**（不是上游家族名）。 */
const BUNDLED = [
  'Source Serif 4 Variable',   // 衬线拉丁（正体 + 斜体）
  'Noto Serif SC',             // 衬线中文
  'Inter Variable',            // 无衬线拉丁
  'Noto Sans SC Variable',     // 无衬线中文
  'IBM Plex Mono',             // 等宽拉丁
];

/**
 * 串行共用一次启动。**顺序不能换**：第二条会按注册名显式 `document.fonts.load` Noto Sans SC 与
 * 等宽栈，排在前面的话，第一条「这个家族有一片 loaded」对这两个家族就不再能证明是**字体栈**
 * 把它们用上了——按名字直接加载也会让它变成 loaded，判据成了自证。
 */
test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;

test.beforeAll(async () => {
  launched = await launchKydog({ seed: seedSettings });
});

test.afterAll(async () => { await teardown(launched); });

/**
 * 三条字体栈的首选家族都来自产物、且真的被用上了。
 *
 * 这条守的是两件曾经同时出错的事：
 *
 * 1. index.html 里原先有一个 Google Fonts 的 <link>，五个家族都从它来——桌面应用因此离线时观感
 *    与在线时不同，且每次启动都向第三方发一次请求。
 * 2. 与此同时产物里**也**打包了 Source Serif（fontsource 的可变包，注册名带 Variable 后缀），而
 *    主题里写的是不带后缀的上游家族名。名字对不上本该退化成兜底字体、一眼可见，但远端那份恰好
 *    注册成不带后缀的同名，于是名字「对上了」——字面完全正常，实际用的是联网拉的那份，打包的
 *    那份一次都没被加载过。
 *
 * 第 1 件（源码与产物 CSS 里没有任何字体 CDN 引用）是静态事实，由
 * src/renderer/theme/fontStacks.test.ts 的「渲染层不引用任何字体 CDN」逐文件扫描守着，这里不再
 * 为它重载页面、监听请求。这里只留运行期才看得到的第 2 件：
 *
 * 判据不能是「量宽度对照」：两份是同一套字面，度量几乎一致（32px 下同为 419.398px），那种
 * 测试在 bug 存在时恒绿——写过一版就是这么废的。这里用协议层事实：**FontFace 的 status**
 * （浏览器只把真正被排版用到的 face 置为 loaded）。
 */
test('58-font-stack: 三条字体栈的首选家族都来自产物，且真的被加载', async () => {
  const { page } = launched;
  const loaded = await page.evaluate(async () => {
    // 三条栈 × 拉丁/中文都真排一遍，逼浏览器去解析各自的首选家族：只 await fonts.ready 不够，
    // 没被用到的 face 永远停在 unloaded。衬线额外排一次斜体（fontsource 的斜体是单独一份
    // @import，漏掉会静默退化成合成假斜体）。
    const cs = getComputedStyle(document.body);
    const combos: [string, string, string][] = [
      [cs.getPropertyValue('--font-serif'), 'Handgloves 123', 'normal'],
      [cs.getPropertyValue('--font-serif'), 'Handgloves 123', 'italic'],
      [cs.getPropertyValue('--font-serif'), '科研文献阅读', 'normal'],
      [cs.getPropertyValue('--font-sans'), 'Handgloves 123', 'normal'],
      [cs.getPropertyValue('--font-sans'), '设置项目线程', 'normal'],
      [cs.getPropertyValue('--font-mono'), 'Handgloves 123', 'normal'],
    ];
    const made: HTMLElement[] = [];
    for (const [family, text, style] of combos) {
      const el = document.createElement('span');
      el.textContent = text;
      Object.assign(el.style, {
        position: 'absolute', left: '0', top: '0', visibility: 'hidden',
        fontSize: '32px', fontFamily: family, fontStyle: style,
      });
      document.body.appendChild(el);
      made.push(el);
    }
    await document.fonts.ready;

    const out: Record<string, string[]> = {};
    document.fonts.forEach((f) => {
      // 同一家族按 unicode-range 切成很多片，各片状态不同：收集全部，断言时看有没有一片 loaded
      (out[f.family] ??= []).push(f.status);
    });
    for (const el of made) el.remove();
    return out;
  });

  for (const family of BUNDLED) {
    expect(loaded[family], `产物里没注册 '${family}'——fonts.css 的 @import 少了它`)
      .toBeDefined();
    expect(
      loaded[family]?.includes('loaded'),
      `'${family}' 一片都没被加载——说明没有任何字体栈写对了它的注册名（注意 fontsource 的`
        + `可变包注册名带 Variable 后缀）。实际状态：${JSON.stringify(loaded[family])}`,
    ).toBe(true);
  }
});

/**
 * 等宽场景下的中文用的是打包的 Noto Sans SC，不是系统默认字体。
 *
 * 界面上确实有中文走等宽（侧栏的「未选中 Thread」「加载中…」这类空态提示），而 IBM Plex Mono
 * 没有中文字形。等宽栈末尾不接中文家族的话，这些字会一路落到系统默认——macOS 上是 PingFang SC、
 * Windows 上是微软雅黑，两个平台长得不一样。
 *
 * 判据只能是**像素**：中文是全角方块，同样字号下任何中文字体量出来的宽度都相等（32px 六个字恒为
 * 192px），宽度对照在这条上恒绿。所以把同一串中文画到画布上比字节。
 *
 * 三次渲染而不是两次：只比「等宽栈 == 显式 Noto Sans SC Variable」会在字体压根不存在时空转
 * （两边都落到系统默认、照样相等）。第三次用一个**不存在的家族名**取到系统默认，断言它与
 * Noto Sans SC 不同，这条测试才不是自证。这样也与平台无关，Windows CI 上同样成立。
 */
test('58-font-stack: 等宽里的中文用打包的 Noto Sans SC，不是系统默认', async () => {
  const { page } = launched;
  const px = await page.evaluate(async () => {
    const TEXT = '未选中加载中';
    const NOTO = '"Noto Sans SC Variable"';
    const NONE = '"__no_such_family__"';   // 取不到 → 系统默认
    const mono = getComputedStyle(document.body).getPropertyValue('--font-mono').trim();

    await Promise.all([mono, NOTO].map((f) => document.fonts.load(`400 32px ${f}`, TEXT)));

    const draw = (family: string) => {
      const c = document.createElement('canvas');
      c.width = 220; c.height = 44;
      const g = c.getContext('2d')!;
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#000';
      // 必须用 alphabetic 基线、把 y 固定住。textBaseline: 'top' 是相对**首选字体**的 ascent
      // 定位的，而这里要比的两次渲染首选字体不同（等宽栈首选 IBM Plex Mono，对照组首选
      // Noto Sans SC）：同样的中文字形会落在不同的垂直位置，像素于是恒不相等，这条断言就永远
      // 红，且红的原因与被测的事情无关。基线定位与首选字体的度量无关，两次落点相同。
      g.textBaseline = 'alphabetic';
      g.font = `400 32px ${family}`;
      g.fillText(TEXT, 0, 36);
      return Array.from(g.getImageData(0, 0, c.width, c.height).data).join(',');
    };
    return { monoStack: draw(mono), noto: draw(NOTO), system: draw(NONE) };
  });

  expect(
    px.noto === px.system,
    '显式指定 Noto Sans SC Variable 画出来的像素与系统默认字体一模一样'
      + '——说明这个家族没打进产物，下面那条断言会变成自证',
  ).toBe(false);

  expect(
    px.monoStack === px.noto,
    '等宽栈画中文得到的像素与 Noto Sans SC Variable 不同'
      + '——说明 --font-mono 末尾没接上打包的中文家族，中文落到了系统默认',
  ).toBe(true);
});
