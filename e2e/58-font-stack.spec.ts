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
      // 没被用到的 face 永远停在 unloaded。
      const el = document.createElement('span');
      el.textContent = 'Handgloves 123 Quartz jock';
      Object.assign(el.style, {
        position: 'absolute', left: '0', top: '0', fontSize: '32px',
        fontFamily: getComputedStyle(document.body).getPropertyValue('--font-serif'),
      });
      document.body.appendChild(el);
      await document.fonts.ready;

      const out: Record<string, string> = {};
      document.fonts.forEach((f) => {
        if (!f.family.startsWith('Source Serif')) return;
        const k = `${f.family}|${f.weight}`;
        // 同名同字重可能有多条（按 unicode-range 分片）：只要有一条 loaded 就算用上了
        if (out[k] !== 'loaded') out[k] = f.status;
      });
      el.remove();
      return out;
    });

    const bundled = Object.entries(status).filter(([k]) => k.startsWith('Source Serif 4 Variable'));
    const remote = Object.entries(status).filter(([k]) => !k.startsWith('Source Serif 4 Variable'));

    expect(bundled.length, `产物里没注册 'Source Serif 4 Variable'：${JSON.stringify(status)}`)
      .toBeGreaterThan(0);
    expect(
      bundled.some(([, s]) => s === 'loaded'),
      `打包的 Source Serif 4 Variable 一条都没被加载——说明 --font-serif 首项没指向它：`
        + `${JSON.stringify(status)}`,
    ).toBe(true);

    // 远端那份可以存在（index.html 的 link 还在），但不该被排版用到。
    // 它不存在也算通过：离线跑 e2e 时那个 link 根本拉不下来。
    for (const [k, s] of remote) {
      expect(s, `${k} 被加载了——衬线仍在用 Google Fonts 拉的那份，不是打包的`).not.toBe('loaded');
    }
  } finally {
    await teardown(launched);
  }
});
