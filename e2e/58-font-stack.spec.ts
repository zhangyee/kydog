import { test, expect } from '@playwright/test';
import { launchKydog, teardown, seedSettings } from './helpers';

/**
 * 衬线正文用的是**打包进产物**的那份 Source Serif，不是 index.html 里那个 Google Fonts 链接
 * 拉下来的同名字体。
 *
 * 背景：应用同时有两个 Source Serif 来源——`@fontsource-variable/source-serif-4`（打进 asar 的
 * woff2 子集，@font-face 注册名带 Variable 后缀）和 index.html 的
 * `<link href="fonts.googleapis.com/css2?...family=Source+Serif+4...">`（运行时联网拉，注册名
 * 不带后缀）。主题的 --font-serif 首项原先写的是不带后缀的那个，于是一直用远端那份，打包的
 * 那份从未被加载过。
 *
 * 判据用 FontFace 的 status，不用「量宽度」：两份都是 Source Serif 4，同一字重下字面度量几乎
 * 一致（实测 32px 下同为 419.3984375px），宽度对照在这个 bug 上恒绿——写过一版就是这么废的。
 * status 是协议层事实：浏览器只会把**真正被排版用到**的那些 face 置为 loaded。
 */
test('58-font-stack: 衬线用的是打包的 Source Serif，不是 Google Fonts 拉的那份', async () => {
  const launched = await launchKydog({ seed: seedSettings });
  const { page } = launched;
  try {
    const status = await page.evaluate(async () => {
      // 真正排一段拉丁文，逼浏览器去解析 --font-serif 首项——只 await fonts.ready 不够，
      // 没被用到的 face 永远停在 unloaded。正体与斜体各排一次：斜体在 fontsource 里是单独一份
      // @import，漏掉它会退化成合成假斜体，而合成是静默的、status 上看不出异常。
      const stack = getComputedStyle(document.body).getPropertyValue('--font-serif');
      const made: HTMLElement[] = [];
      for (const style of ['normal', 'italic']) {
        const el = document.createElement('span');
        el.textContent = 'Handgloves 123 Quartz jock';
        Object.assign(el.style, {
          position: 'absolute', left: '0', top: '0', fontSize: '32px',
          fontFamily: stack, fontStyle: style,
        });
        document.body.appendChild(el);
        made.push(el);
      }
      await document.fonts.ready;

      const out: Record<string, string> = {};
      document.fonts.forEach((f) => {
        if (!f.family.startsWith('Source Serif')) return;
        const k = `${f.family}|${f.weight}|${f.style}`;
        // 同名同字重同样式可能有多条（按 unicode-range 分片）：有一条 loaded 就算用上了
        if (out[k] !== 'loaded') out[k] = f.status;
      });
      for (const el of made) el.remove();
      return out;
    });

    const isBundled = (k: string) => k.startsWith('Source Serif 4 Variable');
    const loadedBundled = (style: string) => Object.entries(status)
      .some(([k, v]) => isBundled(k) && k.includes(`|${style}`) && v === 'loaded');

    expect(Object.keys(status).some(isBundled),
      `产物里没注册 'Source Serif 4 Variable'：${JSON.stringify(status)}`).toBe(true);

    expect(loadedBundled('normal'),
      `打包的 Source Serif 4 Variable 正体没被加载——--font-serif 首项没指向它：`
        + `${JSON.stringify(status)}`).toBe(true);

    expect(loadedBundled('italic'),
      `打包的 Source Serif 4 Variable 斜体没被加载——fonts.css 少 import 了 wght-italic.css，`
        + `设置页的 font-serif italic 会退化成合成假斜体：${JSON.stringify(status)}`).toBe(true);

    // 远端那份可以存在（index.html 的 link 还在），但不该被排版用到。
    // 它不存在也算通过：离线跑 e2e 时那个 link 根本拉不下来。
    for (const [k, v] of Object.entries(status)) {
      if (isBundled(k)) continue;
      expect(v, `${k} 被加载了——衬线仍在用 Google Fonts 拉的那份，不是打包的`).not.toBe('loaded');
    }
  } finally {
    await teardown(launched);
  }
});
