import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings } from './helpers';

/** 打进产物的五个家族，键是 @font-face 的**注册名**（不是上游家族名）。 */
const BUNDLED = [
  'Source Serif 4 Variable',   // 衬线拉丁（正体 + 斜体）
  'Noto Serif SC',             // 衬线中文
  'Inter Variable',            // 无衬线拉丁
  'Noto Sans SC Variable',     // 无衬线中文
  'IBM Plex Mono',             // 等宽拉丁
];

const FONT_CDN = /fonts\.googleapis\.com|fonts\.gstatic\.com|fonts\.bunny\.net|use\.typekit\.net/;

/**
 * 字体全部随产物走：运行期不向任何字体 CDN 发请求，且三条字体栈的首选家族都真的被用上了。
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
 * 所以判据不能是「量宽度对照」：两份是同一套字面，度量几乎一致（32px 下同为 419.398px），那种
 * 测试在 bug 存在时恒绿——写过一版就是这么废的。这里用两个协议层事实：**有没有发出请求**，以及
 * **FontFace 的 status**（浏览器只把真正被排版用到的 face 置为 loaded）。
 */
test('58-font-stack: 字体全部来自产物，运行期不向字体 CDN 发请求', async () => {
  const launched = await launchKydog({ seed: seedSettings });
  const { page } = launched;
  try {
    const cdnRequests: string[] = [];
    page.on('request', (r) => { if (FONT_CDN.test(r.url())) cdnRequests.push(r.url()); });

    // 监听器挂在 launch 之后，首次加载的请求已经错过了——重载一次，让整个文档在监听下重跑。
    await page.reload();
    await page.waitForLoadState('domcontentloaded');

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

    expect(cdnRequests, `重载期间向字体 CDN 发了请求：${cdnRequests.join(', ')}`).toEqual([]);

    for (const family of BUNDLED) {
      expect(loaded[family], `产物里没注册 '${family}'——fonts.css 的 @import 少了它`)
        .toBeDefined();
      expect(
        loaded[family]?.includes('loaded'),
        `'${family}' 一片都没被加载——说明没有任何字体栈写对了它的注册名（注意 fontsource 的`
          + `可变包注册名带 Variable 后缀）。实际状态：${JSON.stringify(loaded[family])}`,
      ).toBe(true);
    }
  } finally {
    await teardown(launched);
  }
});
