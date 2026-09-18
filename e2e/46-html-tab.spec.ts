import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown, testIdSelector, type LaunchedApp } from './helpers';
import { SKIP_WITHOUT_SYMLINK, SYMLINK_SKIP_REASON } from '../src/test-support/symlinkCapability';

/**
 * HTML 报告 tab。两次启动：合成报告那组锁查看器（沙箱、CSP、外链、方向键、图片内联、主题），
 * 真模板那组锁 learning-deck 模板自己的脚本（入场动效、scrollspy、两跳引用、窄档、方向键停靠点）。
 * 每组串行共用一次启动，上一条的状态就是下一条的起点。
 *
 * ⚠️ **沙箱 iframe 一次启动里只有第一次按键可靠送达。** 实测：`page.keyboard.press` 只有第一次
 * 会被送进这个 sandbox srcdoc iframe 的文档，第二次开始 iframe 里的 keydown 计数器就不再增加
 * ——宿主的 document.activeElement 自始至终都是那个 <iframe> 元素，重新 .focus() 也救不回来
 * （只有在 frame 里真点一下才会再收到一次）。这是 Playwright/Electron 往 OOPIF 送键盘事件的
 * 限制，不是被测代码的行为，所以别写「多按几次」的循环，那种测试会停在第二个停靠点上永远超时。
 * 由此来的顺序约束：
 *
 * - 合成报告组：「方向键在节间跳转」验的是**免点击**（srcDoc 就绪后 HtmlFileTab 对 iframe 调
 *   .focus()），它必须是这次启动的第一次按键，而且排在任何一次往这个 frame 里的点击之前——点过
 *   一下 frame 就拿到了焦点，focus effect 坏了它也照样绿。所以它排在「外链」（要点 #external）
 *   前面。切主题会让 iframe 重新导航，放最后。
 * - 真模板组：scrollspy 那条排第一，它的起点断言「当前项是第一条」要在任何滚动之前量（见那条
 *   的注释）；它直接跳到 #glossary，不经过第 1 章，入场动效那条要的「还没进过视口的 .reveal /
 *   .draw」因此仍然完好。方向键那条放最后、是这次启动唯一的一次按键，前面先在 frame 里点一下
 *   武装投递。
 */

const HTML_REL = 'report.html';
const IMAGES_REL = 'images.html';

// 正文里那个 <script> 是探针：沙箱给了 allow-scripts，它得跑起来（#net 的文字才会被改写）。
// #net 判据用协议层事实而不是代理信号：`fetch` 请求失败既可能是 CSP 拦截，也可能是
// 单纯连不上 127.0.0.1:9（没人监听），两者在 .catch() 里产生的都是同一个 TypeError ——
// 用 catch 区分不出"CSP 拦了"和"CSP 没拦、只是连接被操作系统拒绝"，会把假绿和真绿混在一起。
// 真正只在 CSP 生效时才发生的协议层事实是 `securitypolicyviolation` 事件，所以 #net
// 只由这个事件驱动，fetch 的 .catch() 什么都不做。
// #external 是 DOI 外链那条链；#s1 / #s2 / #h2 是方向键翻节那条链——keydown 监听器把
// ArrowDown 接到 #s2.scrollIntoView()，中间那个 2400px 的撑高块让 #s2 起初远在视口之下。
// 页内锚点（srcdoc 的 base href）由真模板组的「两跳引用」守，入场动效由真模板组的
// 「.reveal 滚入视口后可见」守——这份合成 fixture 只负责查看器自己那几条。
const REPORT_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>测试报告</title>
<style>body { background: var(--paper, #ffffff); color: var(--ink, #222222); }
  section { min-height: 120vh; }</style>
</head>
<body>
<h1 id="heading">知识地图</h1>
<p id="net">NOT-RUN</p>
<p><a id="external" href="https://example.com/10.1000/xyz" target="_blank" rel="noopener">DOI 外链</a></p>
<div style="height: 2400px"></div>
<section id="s1">第一节</section>
<section id="s2"><h2 id="h2">第二节</h2></section>
<script>
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') document.getElementById('s2').scrollIntoView();
  });
  document.addEventListener('securitypolicyviolation', (e) => {
    document.getElementById('net').textContent = 'CSP-BLOCKED:' + e.violatedDirective;
  });
  // 连接失败与被 CSP 拦截会产生同样的 TypeError，这里什么都不做——
  // 判据只看上面那个 securitypolicyviolation 事件。
  fetch('http://127.0.0.1:9/beacon').catch(() => {});
</script>
</body>
</html>
`;

// 真模板。仓库里此前没有任何东西解析过它——脚本块里写出语法错误也会静默发布，
// 而它正是 /learning-deck 让 agent 逐字照抄的那份文件。seed 进去当报告打开，
// 就等于让 Chromium 替我们解析一遍，再对它自己那几条能力（入场动效、SVG 描边、
// 方向键停靠点、目录 scrollspy、窄档目录横条）下断言。路径相对 cwd：e2e 由 playwright 从仓库根跑起
// （helpers.ts 传给 electron 的 '.vite/build/main.js' 也是这么解析的）。
const TEMPLATE_REL = 'template.html';
const TEMPLATE_SRC = path.resolve(process.cwd(), 'src/skills/learning-deck/assets/report-template.html');

// ── 真模板 + 最小章节 fixture ────────────────────────────────────────────────
//
// v5 起模板 <body> 里**没有任何示例内容**：没有示例章节、没有 .reveal、没有 .draw，
// ④ 知识点正文那一块只剩一行插入锚点注释。（为什么删干净见模板里
// 「④ 知识点正文 —— 章节的插入锚点」那段：v4 留了两个示例章节的壳，替换壳比插入贵
// 得多，于是真跑时九章全走插入、两个壳原地留下。）
//
// 下面这几条测试要断言的是**模板自己的行为**——入场动效、SVG 描边、方向键停靠点、
// 目录 scrollspy、窄档目录横条——而这些行为全部长在章节上。所以 fixture 的做法是：
//
//   读真模板 → 找到那一行插入锚点 → 用一对最小的「幕封页 + .concept」把它换掉
//
// **这跟 /learning-deck 第 5.5 小步插章节是同一个操作**（`references/layout.md`
// 的「④ 一章画完的样子」定义了这对标记的形态），所以被测的仍然是真模板：
// <style> 一个字没动、文末那个唯一的 <script> 一个字没动、三栏网格与 @media 断点
// 一个字没动。fixture 只提供内容标记，也就是真报告里同样由 agent 提供的那一半。
//
// ⚠️ **锚点找不到就 throw，不要静默跳过。** 模板哪天把这行注释改了名或删了，
//    这些测试必须**红在构造 fixture 这一步**，而不是退化成「测了一份没有章节的
//    模板、断言全过」。这条 throw 就是模板漂移的探测器。
const CHAPTER_ANCHOR = '<!-- ④-ANCHOR 知识点章节插在这一行之前 ⟨待填⟩ -->';
const TOC_SUB_ANCHOR = '          <!-- 有几章写几条，一章一行：<li><a href="#cN">§N 标题</a></li> ⟨待填⟩ -->';
const REFS_HEADING = '  <h2>参考文献</h2>';
const PRIMER_HEADING = '  <h2>前序速览</h2>';

// ③ 前序速览也要填出真实高度，不能留空。
//
// 这不是「为了让测试过」的凑数：`html` 上写着 scroll-snap-type: y proximity，
// 而 .curtain 是 scroll-snap-align: start。#primer 空着的时候第一张幕封页离它只有
// 几十像素，instant scrollTo 停在 #primer 的落点之后会被 proximity 直接吸到幕封页上
// ——「ArrowDown 从 #primer 落到第一个幕封页」那条测试的**前置条件**（幕封页此刻还在
// 视口下方）就不成立了，测试量的东西也就没了。真报告里 ③ 一定有内容，
// fixture 补上它才是照着真形态测。
const PRIMER_ITEMS = [
  ['12 导联与采样率', '体表 12 个观察角度，各自看到心脏电活动的一个投影。常见采样率 250–500 Hz。'],
  ['基线漂移', '呼吸与电极接触带来的低频起伏，会把 ST 段的绝对高度整段抬起或压下。'],
  ['对比预训练', '不用标签，靠「同一段的两个视图应该靠得更近」这一条来学表示。'],
  ['线性探针', '冻住主干只训一层线性分类头，用来量表示本身好不好，而不是量微调技巧。'],
  ['类别不平衡', '阳性样本占比很低时，准确率会被多数类刷满，得看 AUPRC 而不是 accuracy。'],
  ['外部验证', '换一家医院、换一批设备再测一次。同院测试集上的数字撑不起临床结论。'],
];

/** 一对最小的「幕封页 + .concept」，形态照 references/layout.md「④ 一章画完的样子」。 */
function fixtureChapter(n: number): string {
  return `<div class="curtain" id="c${n}">
  <div class="curtain-num">§${n}</div>
  <h2 class="curtain-title">e2e fixture 第 ${n} 节</h2>
  <p class="curtain-lede">这一节只为 e2e 存在，形态照 references/layout.md。</p>
</div>

<section class="concept">
  <p class="lede">这一节只为 e2e 存在，形态照 references/layout.md。</p>

  <aside class="aside reveal">
    <p>依赖侧注：本节假设你已经读过 <a href="#map">知识地图</a>。</p>
  </aside>

  <h3>它解决什么问题</h3>
  <p>正文一段，撑出高度用。</p>

  <div class="with-figure">
    <h3>机制</h3>
    <p>讲下面这张图的那一段。</p>
    <figure>
      <svg viewBox="0 0 640 120" role="img" aria-label="从输入到输出的一条箭头">
        <title>e2e fixture 的最小示意图</title>
        <defs>
          <marker id="ld-arrow-f${n}" viewBox="0 0 10 10" refX="8" refY="5"
                  markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path class="arrow-head" d="M0,0 L10,5 L0,10 z"/>
          </marker>
        </defs>
        <rect x="20" y="34" width="150" height="52" rx="4" class="svg-frame"/>
        <text class="svg-label" x="95" y="65" text-anchor="middle" font-size="14">输入</text>
        <path class="arrow-line draw" d="M176 60 L 464 60" marker-end="url(#ld-arrow-f${n})"/>
        <rect x="470" y="34" width="150" height="52" rx="4" class="svg-hi"/>
        <text class="svg-label" x="545" y="65" text-anchor="middle" font-size="14">输出</text>
      </svg>
      <figcaption>
        <b>图 ${n + 1}</b> e2e fixture 用的最小示意图。
        <br>示意图为本报告自画，不对应原文任何一张图。
      </figcaption>
    </figure>
  </div>

  <div class="example reveal">
    <span class="tag">举个例子</span>
    <p>一个具体到能被核对的例子。</p>
  </div>

  <div class="boundary reveal">
    <h3>常见误解与边界</h3>
    <ul><li><strong>「这是真报告」</strong>——不是，它是 e2e 的 fixture。</li></ul>
  </div>

  <div class="source reveal">
    <h3>出处</h3>
    <ul><li>见 <a href="#r-fixture">Fixture et al. (2026)</a>。</li></ul>
  </div>

  <p class="checkout reveal">
    <b>读完这节你应该能回答：</b>这对标记是从哪一册抄来的？
  </p>
  <p class="back"><a href="#map">↑ 回知识地图</a></p>
</section>`;
}

/** 真模板 + 两章 fixture。两章是为了让文档高到能滚（每张幕封页 100vh）。 */
function buildTemplateFixture(template: string): string {
  if (!template.includes(CHAPTER_ANCHOR)) {
    throw new Error(
      `真模板里找不到章节插入锚点：${CHAPTER_ANCHOR}\n`
      + '模板改了形态，下面那几条「真模板」测试要跟着改 —— 不要把这个 throw 去掉。',
    );
  }
  if (!template.includes(TOC_SUB_ANCHOR)) {
    throw new Error(
      `真模板里找不到目录里知识点那组的占位注释：${TOC_SUB_ANCHOR}\n`
      + '目录 scrollspy 那条测试要靠它插 §N 条目 —— 不要把这个 throw 去掉。',
    );
  }
  if (!template.includes(REFS_HEADING)) {
    throw new Error(
      `真模板里找不到 ⑨ 参考文献那个 <h2>：${REFS_HEADING}\n`
      + '两跳引用那条测试要靠它插一条 <li id="r-…"> —— 不要把这个 throw 去掉。',
    );
  }
  if (!template.includes(PRIMER_HEADING)) {
    throw new Error(
      `真模板里找不到 ③ 前序速览那个 <h2>：${PRIMER_HEADING}\n`
      + '方向键那条测试要靠它撑出高度 —— 不要把这个 throw 去掉。',
    );
  }
  return template
    .replace(TOC_SUB_ANCHOR,
      '          <li><a href="#c1">§1 e2e fixture 第 1 节</a></li>\n'
      + '          <li><a href="#c2">§2 e2e fixture 第 2 节</a></li>')
    .replace(CHAPTER_ANCHOR, `${fixtureChapter(1)}\n\n${fixtureChapter(2)}`)
    .replace(PRIMER_HEADING, `${PRIMER_HEADING}
  <p>下面这些不是本报告的重点，但后文会用到。够用就行。</p>
  <dl>
${PRIMER_ITEMS.map(([t, d]) => `    <dt>${t}</dt>\n    <dd>${d}</dd>`).join('\n')}
  </dl>`)
    // 两跳的第二站：正文 .source 里的 #r-fixture 落到这条 <li> 上，
    // 这条 <li> 里的 a.ref-link 才是外链。
    .replace(REFS_HEADING, `${REFS_HEADING}
  <ol>
    <li id="r-fixture">
      Fixture, F. et al. (2026). <i>A Minimal Fixture.</i> e2e 45(1), 1–2.
      <br><a class="ref-link" href="https://example.com/10.1000/fixture" target="_blank" rel="noopener">https://example.com/10.1000/fixture</a>
    </li>
  </ol>`);
}

// Task 7b：查看器把报告里的相对路径 <img> 在渲染时内联成 data URI。
// 1x1 透明像素的最小合法 PNG（能被真解码，不是随手拼的假字节）。
const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

// 在 REPORT_HTML 基础上加三张图，另存成同目录的 images.html、在自己的 tab 里打开：#fig 是
// 合法的报告目录内相对路径（应内联成功），#bad 是逃出报告目录树的路径（应被拒绝、退化成 alt
// 文字），#evil 是报告目录树内的一个符号链接、文件名和路径字符串都合规，但链接目标在树外
// （Task 7b review Critical：resolveInlineTarget 的字符串校验拦不住这个向量，得靠主进程
// file.readBytesWithin 的 realpath 校验拦）。report.html 本身不带图，其余几条的断言/时序不受影响。
const REPORT_HTML_WITH_IMAGES = REPORT_HTML.replace(
  '<h1 id="heading">知识地图</h1>',
  '<h1 id="heading">知识地图</h1>\n'
  + '<img id="fig" src="fig.png" alt="架构图">\n'
  + '<img id="bad" src="../outside.png" alt="ALT-FALLBACK">\n'
  + '<img id="evil" src="evil-link.png" alt="EVIL-FALLBACK">',
);

/** 选中 thread（右栏于是显示这个项目的文件树），双击文件树里的一行打开它的 tab。 */
async function openHtml(page: Page, htmlPath: string) {
  await page.getByTestId('thread-thr-1').click();
  const fsRow = page.getByTestId(`fs-${htmlPath}`);
  await fsRow.waitFor();
  await fsRow.dblclick();
  await expect(page.getByTestId(`tab-${htmlPath}`)).toBeVisible();
  return page.frameLocator(testIdSelector(`html-frame-${htmlPath}`));
}

// 主题一变，HtmlFileTab 的注入 effect 就重建 srcDoc，iframe 随即导航，
// 在飞的 evaluate 会以「Execution context was destroyed」收场——那是取早了，不是坏了
// （全量串行跑时机器负载把时序拉开才撞得到，2026-09-01 macOS 观测到一次）。而
// expect.poll 只在断言不匹配时重试，回调抛错会立刻判死，所以「跟随主题」那条得把
// 这类瞬态错误折叠成 null 让 poll 继续等；其他错误照抛，真坏了不许吞。
// 配套纪律：poll 的断言必须是 null 满足不了的正向匹配（toBe('midnight')），
// 用 .not.toBe(...) 会把重建期的 null 当成「变了」放过去。
function nullWhileFrameRebuilds<T>(p: Promise<T>): Promise<T | null> {
  return p.catch((err) => {
    if (/Execution context was destroyed|Frame was detached/i.test(String(err))) return null;
    throw err;
  });
}

// ── 合成报告：查看器本身 ────────────────────────────────────────────────────
//
// 「双击打开 → 渲染内容」「沙箱执行页面脚本」不再单开：每条都先打开 frame、读它的内容，
// 而 #net 的文字只能由页面脚本写上去（CSP 那条）。阅读字号、文件改了自动重载、切走再切回的
// 焦点这三条组件接线由 src/renderer/panels/main-pane/html/HtmlFileTab.test.tsx 守。
test.describe('46-html-tab 合成报告', () => {
  test.describe.configure({ mode: 'serial' });

  let launched: LaunchedApp;
  let htmlPath = '';
  let imagesPath = '';

  test.beforeAll(async () => {
    launched = await launchKydog({
      seed: async (home) => {
        await seedSettings(home);
        const projectPath = path.join(home, 'proj');
        await fs.mkdir(projectPath, { recursive: true });
        htmlPath = path.join(projectPath, HTML_REL);
        imagesPath = path.join(projectPath, IMAGES_REL);
        await fs.writeFile(htmlPath, REPORT_HTML);
        await fs.writeFile(imagesPath, REPORT_HTML_WITH_IMAGES);
        await fs.writeFile(path.join(projectPath, 'fig.png'), MINIMAL_PNG);
        // 放在 proj/ 外面一级 —— 真实存在、可读，证明拒绝的原因是「逃出目录树」而不是
        // 单纯的「文件不存在」。
        const outsidePath = path.join(home, 'outside.png');
        await fs.writeFile(outsidePath, MINIMAL_PNG);
        // 符号链接放在 proj/ 里面（字符串路径 'evil-link.png' 完全合规、扩展名也在白名单），
        // 但链接目标指向 proj/ 外面的 outside.png —— 字符串校验看不出问题，得靠 realpath。
        // 建不了软链的机器上不建，只跳过符号链接那一条；CI 设了 KYDOG_REQUIRE_SYMLINK=1 时
        // SKIP_WITHOUT_SYMLINK 为 false，这里照建，建不了就以 EPERM 红在启动这一步。
        if (!SKIP_WITHOUT_SYMLINK) await fs.symlink(outsidePath, path.join(projectPath, 'evil-link.png'));
        await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
      },
    });
    const frame = await openHtml(launched.page, htmlPath);
    await expect(frame.locator('#heading')).toHaveText('知识地图');
  });

  test.afterAll(async () => { await teardown(launched); });

  const reportFrame = () => launched.page.frameLocator(testIdSelector(`html-frame-${htmlPath}`));

  test('46-html-tab: CSP 拦住脚本的对外请求', async () => {
    // 判据是 securitypolicyviolation 事件（协议层事实），不是 fetch 失败与否
    // （代理信号——连接被拒和被 CSP 拦截产生同样的 TypeError，见 fixture 里的注释）。
    // #net 只由页面脚本改写，所以这一条同时证明了沙箱确实执行页面里的脚本（v2 起 allow-scripts）。
    await expect(reportFrame().locator('#net')).toHaveText(/^CSP-BLOCKED:connect-src/, { timeout: 10000 });
  });

  test('46-html-tab: 方向键在节间跳转', async () => {
    const { page } = launched;
    const frame = reportFrame();
    await expect.poll(() => frame.locator('body').evaluate((el) => el.ownerDocument.readyState)).toBe('complete');

    // 不点击：验的就是 HtmlFileTab 里 srcDoc 就绪后对 iframe 调 .focus() 是否真的让
    // 方向键免点击生效（所以它排在本组任何一次往 frame 里的点击之前，见文件头）。
    // 按键不能抢跑在 HtmlFileTab 的 focus effect 之前：CI 慢机上 effect 晚到，键落进宿主
    // 文档就永久丢了（v0.1.0 tag run darwin-arm64 双败即此形态）。锚定的是协议事实本身
    // ——宿主的 activeElement 已经是这个 iframe；不点击（点击会破坏本测试「免点击」的
    // 验证目的），不循环按键（文件头 ⚠️ 的一次性纪律）。
    await expect.poll(() => page.evaluate((sel) => {
      const el = document.activeElement;
      return el instanceof HTMLIFrameElement && el.matches(sel);
    }, testIdSelector(`html-frame-${htmlPath}`))).toBe(true);
    await page.keyboard.press('ArrowDown');
    await expect.poll(() =>
      frame.locator('#h2').evaluate((el) => el.getBoundingClientRect().top),
    ).toBeLessThan(200);
  });

  test('46-html-tab: 报告里的外链交给系统浏览器打开', async () => {
    const { app } = launched;
    const frame = reportFrame();

    // 这条链是 sandbox 的 allow-popups → main.ts 的 setWindowOpenHandler → shell.openExternal。
    // 在主进程里把最后一环换成记账，中间任何一环被「少给一个权限更好」收紧掉都会红。
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as unknown as { __openedExternal: string[] }).__openedExternal = opened;
      shell.openExternal = (url: string) => { opened.push(url); return Promise.resolve(); };
    });

    await expect(frame.locator('#external')).toBeVisible();
    await expect.poll(() => frame.locator('body').evaluate((el) => el.ownerDocument.readyState)).toBe('complete');

    // 点击放进 poll 里重试：frame 刚建好那一小段时间里，第一次合成点击偶尔会被吞掉
    // （实测约 1/4，紧接着再点必中）。断言落在「URL 原样到了 shell.openExternal」，
    // allow-popups 被拿掉的话这里怎么点都不会有记录，10 秒后变红。
    await expect.poll(async () => {
      await frame.locator('#external').click();
      return app.evaluate(() => (globalThis as unknown as { __openedExternal: string[] }).__openedExternal);
    }, { timeout: 10_000 }).toContain('https://example.com/10.1000/xyz');
  });

  test('46-html-tab: 报告目录内的本地图片渲染时内联成 data URI，逃出报告目录的路径被拒绝、退化成 alt 文字', async () => {
    const frame = await openHtml(launched.page, imagesPath);
    const fig = frame.locator('#fig');
    await expect(fig).toBeVisible();

    // src 以 data:image/png;base64, 开头只证明字符串被替换了——那怕替换成的是垃圾字节
    // 这条也能过。真正证明"内联出来的字节确实是一张能被浏览器解码的图"的是
    // naturalWidth > 0：解码失败的 <img> naturalWidth 恒为 0。两条都要断言。
    await expect.poll(() => fig.evaluate((el: HTMLImageElement) => el.src)).toMatch(/^data:image\/png;base64,/);
    await expect.poll(() => fig.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

    // 逃出目录树的那张：src 属性被整个摘掉（不是留一个读不到的坏路径），元素靠 alt 退化成
    // 文字。「没有 src」的正向对照是上面 #fig 那张的 src。
    const bad = frame.locator('#bad');
    await expect.poll(() => bad.evaluate((el) => el.getAttribute('data-kydog-inline'))).toBe('rejected');
    expect(await bad.evaluate((el) => el.hasAttribute('src'))).toBe(false);
    expect(await bad.evaluate((el) => el.getAttribute('alt'))).toBe('ALT-FALLBACK');
  });

  // Task 7b review 的 Critical 修复：resolveInlineTarget 只做字符串校验（逃出 baseDir
  // 的相对路径、绝对路径），挡不住「路径字符串本身完全合规、实际是个指向目录树外的
  // 符号链接」这种向量。这条测试是唯一验证 file.readBytesWithin 那道 realpath 校验
  // 真的在端到端链路里生效的证据——单测（fileService.test.ts）只测了 realpath
  // 校验函数本身，没有验证 HtmlFileTab → inlineLocalImages → RPC 这条链真的把它接上了。
  test('46-html-tab: 报告目录内指向目录外的符号链接被拒绝，不能靠字符串校验绕过', async () => {
    test.skip(SKIP_WITHOUT_SYMLINK, SYMLINK_SKIP_REASON);
    const frame = launched.page.frameLocator(testIdSelector(`html-frame-${imagesPath}`));
    const evil = frame.locator('#evil');
    await expect.poll(() => evil.evaluate((el) => el.getAttribute('data-kydog-inline'))).toBe('rejected');
    expect(await evil.evaluate((el) => el.hasAttribute('src'))).toBe(false);
    expect(await evil.evaluate((el) => el.getAttribute('alt'))).toBe('EVIL-FALLBACK');
  });

  test('46-html-tab: 报告跟随 app 主题', async () => {
    const { page } = launched;
    // 切回 report.html 那个 tab（上一条停在 images.html 上）。
    await page.getByTestId(`tab-${htmlPath}`).click();
    await expect(page.getByTestId(`file-pane-${htmlPath}`)).toBeVisible();

    const body = reportFrame().locator('body');
    const bgOf = () => nullWhileFrameRebuilds(
      body.evaluate((el) => getComputedStyle(el).backgroundColor));
    // 主题**身份**（reportTheme.ts 的 REPORT_THEME_ATTR）。转发过去的变量只有颜色的
    // 值，说不出「这是哪一套主题」；报告里按主题语义取色的地方（learning-deck 抬头
    // 那条深色带上的前景色）靠的就是这个属性。没有它，下游只能量亮度去猜——
    // 正是 CLAUDE.md Principles 禁的那种 proxy。
    const themeAttrOf = () => nullWhileFrameRebuilds(body.evaluate((el) =>
      el.ownerDocument.documentElement.getAttribute('data-kydog-theme')));

    // 先锚定身份再取值：身份和颜色烤在同一份 srcdoc 里，身份到位说明读到的已经是
    // 注入完的文档（不是初始提交前的 about:blank），此后到切主题前不再有导航。
    await expect.poll(themeAttrOf).toBe('vellum');
    const before = await bgOf();
    expect(before).not.toBeNull();

    // 走真实 UI 切主题（同 e2e/08-theme-switch.spec.ts 的路径）：
    // 用户菜单 → midnight。注入的 --paper 变了，frame 里的背景必须跟着变。
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="theme-midnight"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');

    // 身份跟着一起换：只换值不换身份的话，深色带上的前景色会停在浅纸那一支。
    await expect.poll(themeAttrOf).toBe('midnight');
    const after = await bgOf();
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });
});

// ── 真模板（src/skills/learning-deck/assets/report-template.html）────────────
//
// 上面那组用的是合成 fixture，锁的是查看器（沙箱、CSP、外链、方向键、图片内联、主题）。
// 下面这组 seed 的是**真模板本身**，锁的是模板文末那个唯一的 <script> 块真的把
// 它承诺的几件事做到了：逐条入场 / SVG 描边、目录 scrollspy、方向键沿停靠点前进。
// 在这之前仓库里没有任何东西解析过这份文件——脚本块里写出语法错误也不会有测试变红，
// 而它是给 agent 逐字照抄的模板，坏了就是每份报告都坏。
test.describe('46-html-tab 真模板', () => {
  test.describe.configure({ mode: 'serial' });

  let launched: LaunchedApp;
  let templatePath = '';

  test.beforeAll(async () => {
    launched = await launchKydog({
      seed: async (home) => {
        await seedSettings(home);
        const projectPath = path.join(home, 'proj');
        await fs.mkdir(projectPath, { recursive: true });
        templatePath = path.join(projectPath, TEMPLATE_REL);
        const template = await fs.readFile(TEMPLATE_SRC, 'utf8');
        await fs.writeFile(templatePath, buildTemplateFixture(template));
        await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
      },
    });
    // 打开真模板那个 tab，等到脚本已经跑完。
    const frame = await openHtml(launched.page, templatePath);
    await expect(frame.locator('.deck-head h1')).toBeVisible();
    await expect
      .poll(() => frame.locator('body').evaluate((el) => el.ownerDocument.readyState))
      .toBe('complete');
  });

  test.afterAll(async () => { await teardown(launched); });

  const templateFrame = () => launched.page.frameLocator(testIdSelector(`html-frame-${templatePath}`));

  /** 瞬移回文档顶。behavior: 'instant' 是必须的：html 上写了 scroll-behavior: smooth，'auto' 在这份文档里等同 smooth。 */
  async function scrollToTop() {
    const frame = templateFrame();
    await frame.locator('body').evaluate((el) => {
      el.ownerDocument.defaultView!.scrollTo({ top: 0, behavior: 'instant' });
    });
    await expect
      .poll(() => frame.locator('body').evaluate((el) => el.ownerDocument.defaultView!.scrollY))
      .toBe(0);
  }

  // 这条**取代了 v4 那条「顶部进度条随滚动变宽」**：进度条 v5 整个删掉了
  // （用户决定，理由见模板 <style> 里「顶部进度条已经删掉」那段），被测对象没了。
  //
  // 换成 scrollspy 不是随便挑的替补：旧那条真正守着的是「文末那个唯一的 <script> 真的
  // 跑起来了、而且真的在响应滚动」——脚本被 CSP 拦掉、语法错误、scroll 监听写错，
  // 三种失败模式旧那条都能抓。删掉进度条之后，模板里**唯一**还符合这个描述的行为就是
  // 目录的当前项高亮（`.is-current` + `aria-current`），而它此前没有任何测试覆盖。
  // 同一个失败模式，换了一个仍然真实存在的被测对象。
  //
  // ⚠️ 判据是「高亮**跟着滚动挪**」，不是「有一个 .is-current」：载入时脚本会立刻
  //    sync() 一次并把第一条设成当前项，只断言「存在」的话脚本挂在 addEventListener
  //    那一行也照样绿。所以先断言初始是 #map，再滚下去断言变成 #glossary。
  //
  // ⚠️ 本组第一条、在任何滚动之前跑：起点那条 #map 量的是**载入时**那次同步——模板脚本里
  //    记着 OOPIF 还没布局时 sync() 会锁死在目录最后一条、要靠 body 上的 IntersectionObserver
  //    在真布局之后再同步一次（CI 实测锁死后 5 秒零纠正）。之前滚过的话，scroll 监听会把它
  //    顺手纠正过来，这一步就量不到那条路径了。
  test('46-html-tab: 真模板——滚动时目录当前项跟着走', async () => {
    const frame = templateFrame();
    const currentHref = () => frame.locator('body').evaluate((el) => {
      const a = el.ownerDocument.querySelector('.toc a.is-current');
      return a ? a.getAttribute('href') : null;
    });

    // 载入时 sync() 跑过一次，scrollY 是 0 ⇒ 当前项是第一条。
    await expect.poll(currentHref).toBe('#map');

    // 滚到「⑦ 术语对照」刚过判定线（视口上方三成处）的位置：模板脚本取的是
    // scrollY + innerHeight * 0.3，所以让 #glossary 的文档内 top 落在这条线上方
    // 10px —— 它过线、而它后面那条（#next）还没过，命中唯一确定。
    await frame.locator('body').evaluate((el) => {
      const doc = el.ownerDocument;
      const win = doc.defaultView!;
      const g = doc.querySelector('#glossary')!;
      const top = g.getBoundingClientRect().top + win.scrollY;
      win.scrollTo({ top: top - win.innerHeight * 0.3 + 10, behavior: 'instant' });
    });

    await expect.poll(currentHref).toBe('#glossary');
    // aria-current 跟 class 一起设 —— 只加 class 的话屏读者读得到目录，却读不出
    // 「现在在哪一节」，而那正是 scrollspy 唯一的用处。
    await expect(frame.locator('.toc a[href="#glossary"]')).toHaveAttribute('aria-current', 'page');
  });

  test('46-html-tab: 真模板——.reveal 滚入视口后可见，.draw 路径描完', async () => {
    const frame = templateFrame();
    const reveal = frame.locator('.reveal').first();
    const opacity = () => reveal.evaluate((el) => getComputedStyle(el).opacity);
    // 先确认脚本真的把它压成了 0——否则下面「最终是 1」分不清是做完了淡入，
    // 还是脚本压根没跑（那种失败模式下元素本来就一直是 1）。上一条瞬移到 #glossary
    // 没经过第 1 章，这第一个 .reveal 还没进过视口。
    await expect.poll(opacity).toBe('0');

    await reveal.scrollIntoViewIfNeeded();
    await expect(reveal).toBeVisible();
    await expect.poll(opacity).toBe('1');

    // SVG 描边：JS 把 stroke-dasharray 设成路径长度、dashoffset 从满长动画到 0。
    // 两条都要断言——只看 dashoffset 是 '0px' 会假绿：脚本没跑时它本来就是 0px，
    // dasharray 则会停在默认的 'none'。
    const draw = frame.locator('.draw').first();
    await draw.scrollIntoViewIfNeeded();
    await expect
      .poll(() => draw.evaluate((el) => getComputedStyle(el).strokeDasharray))
      .not.toBe('none');
    await expect
      .poll(() => draw.evaluate((el) => getComputedStyle(el).strokeDashoffset))
      .toBe('0px');
  });

  // v5 的两跳引用：正文 .source 里的 <a href="#r-…"> 先落到 ⑨ 参考文献那条 <li>，
  // 那条 <li> 里的 a.ref-link 才通向论文原 URL。v4 是正文直接外链，点一下就跳出 app。
  //
  // 为什么值得单开一条：这条链依赖的是**查看器注入的 <base href="about:srcdoc">**
  // （srcdoc 文档的 base URL 本来继承宿主，href="#x" 会被当成跨文档导航——
  // packaged 下静默无事，dev 下整个 frame 导航去宿主页面）。两种失败都不报错，
  // 所以断言落在「真的滚到那条 <li> 了」和「:target 底色真的上了」，不是「点得动」。
  // 页内锚点这套机制只由这一条守（合成报告那组不再单测「点页内锚点滚到对应章节」）。
  test('46-html-tab: 真模板——正文引用两跳落到参考文献那一条', async () => {
    const frame = templateFrame();
    // 从文档顶开始，免得上一条停下的位置恰好让参考文献在视口里。
    await scrollToTop();

    const cite = frame.locator('.source a[href="#r-fixture"]').first();
    const item = frame.locator('#r-fixture');

    // 前置条件：参考文献那一条此刻在视口外 —— 否则「落到它」不能证明是这次点击干的。
    await expect(item).not.toBeInViewport();

    // 点击放进 poll 里重试：frame 刚建好那一小段时间里，第一次合成点击偶尔会被吞掉
    // （实测约 1/4，紧接着再点必中）。点锚点是幂等的，重试不改变语义。
    await expect.poll(async () => {
      await cite.click();
      return frame.locator('body').evaluate((el) => el.ownerDocument.defaultView!.location.href);
    }, { timeout: 10_000 }).toBe('about:srcdoc#r-fixture');
    await expect(item).toBeInViewport();

    // .refs li:target 的底色 —— 落地时读者要看得出「就是这一条」。
    // 没有这条断言，「跳过去了但看不出跳到哪一条」会静默通过。
    const bg = await item.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('transparent');

    // 第二跳仍然是外链：a.ref-link 带 target/rel，由 setWindowOpenHandler 交给系统浏览器
    // （那条链本身由合成报告那组「报告里的外链交给系统浏览器打开」覆盖）。
    await expect(item.locator('a.ref-link')).toHaveAttribute('target', '_blank');
    await expect(item.locator('a.ref-link')).toHaveAttribute('rel', 'noopener');
  });

  // 窄面板（报告面板 < 820px）是 KyDog **默认窗口唯一会走到的那一档**：三栏退化成单栏。
  //
  // ⚠️ **这条测的行为在 v7 里反过来了。** v3–v6 这一档把左侧目录树退成正文上方一条
  // sticky 的胶囊横条，这里原本钉的是「横条贴得住、而且与正文列等宽左对齐」。
  // 用户第五次真跑后拍板**窄档干脆不显示目录**：横条的条目排成一行横向滚动，最长的
  // 那几条被右边缘截断（真跑里是 `§2 从患者、就诊与多份 ECG 建立样…`），读全还得先
  // 横向拖一次，而它常驻在正文上方还占掉一截首屏。被测行为没了，这条跟着改成
  // 断言「窄档下没有这条横条」。
  //
  // ⚠️ 三组断言缺一不可，少任何一组这条都会退化成自证的空壳：
  // (1) `.toc` 仍然**在 DOM 里**（count === 1）—— ≥820px 那两档还要拿它当左侧导航树，
  //     两档共用同一份标记。只测「看不见」的话，把 <nav class="toc"> 整个删掉也会绿，
  //     而那会顺手弄坏宽档。
  // (2) 窄档下它**不可见、且不占版面**（getClientRects() 为空）—— display: none 才算数，
  //     只是视觉上不显眼不算。
  // (3) **滚动之后再量一次**。旧横条是 sticky 的：不滚动时它本来就在顶上，静态量一次
  //     区分不了「没有横条」和「有横条但还没滚走」。真正能抓住「有人把横条改回来」的
  //     是滚动之后那一次。
  //
  // 反向验证过（把窄档那段 CSS 临时改回 v6 的横条形态 —— .toc 恢复 sticky / top: 0 /
  // 纸色底 + .toc-body 横向滚动 + 条目胶囊化）：(2)(3) 两组立刻变红
  // （`toBeHidden` 失败、getClientRects().length 量到 1），(1) 仍然绿。
  //
  // ⚠️ 窄档删掉目录之后导航靠正文自己：② 知识地图（`#map`，节点指向各章 `#cN`）、
  // 每章末尾那行 `<p class="back"><a href="#map">↑ 回知识地图</a></p>`、方向键 /
  // Home / End、正文交叉引用与术语表锚点。下面只断言 `#map` —— 模板是一副空骨架
  // （v5 起 <body> 里全是 ⟨待填⟩ 注释），章节与它们末尾的 `.back` 要等 agent 渲染
  // 才存在，在模板上断言不了。方向键那条路径由本组最后一条守着。
  test('46-html-tab: 真模板——窄面板下不显示顶部目录横条', async () => {
    const frame = templateFrame();
    // (2) 要在文档顶量（旧横条不滚动时本来就在顶上），(3) 要从这里真滚下去；上一条停在参考文献。
    await scrollToTop();

    // 前置条件：报告面板真的落在窄档。helpers.ts 把窗口钉在 1024×720，减去左会话列表 260 与
    // 右 Inspector 280，报告文档的 clientWidth（不含常驻滚动条）实测 461 px。哪天这几个默认值
    // 变了，这条断言会先红，提醒回来重看这条测试。
    const clientWidth = await frame.locator('body')
      .evaluate((el) => el.ownerDocument.documentElement.clientWidth);
    expect(clientWidth).toBeLessThan(820);

    const toc = frame.locator('.toc');

    // (1) 标记还在 —— 删的是窄档的显示，不是这份 DOM。
    await expect(toc).toHaveCount(1);

    // (2) 窄档下不可见、不占版面。
    await expect(toc).toBeHidden();
    const boxes = () => frame.locator('body')
      .evaluate((el) => el.ownerDocument.querySelector('.toc')!.getClientRects().length);
    expect(await boxes()).toBe(0);

    // (3) 滚动之后再量一次 —— 旧横条是 sticky 的，只有这一次量得出区别。
    // ⚠️ 别写死坐标：html 上是 scroll-snap-type: y proximity、.curtain 是
    //    scroll-snap-align: start，落点离某张幕封页够近就会被吸走（实测过）。
    //    #glossary 是个 section[id]，本身不是吸附点，前后也没有幕封页，落点确定。
    await frame.locator('body').evaluate((el) => {
      const doc = el.ownerDocument;
      const win = doc.defaultView!;
      const g = doc.querySelector('#glossary')!;
      win.scrollTo({ top: g.getBoundingClientRect().top + win.scrollY, behavior: 'instant' });
    });
    await expect
      .poll(() => frame.locator('body').evaluate((el) => el.ownerDocument.defaultView!.scrollY))
      .toBeGreaterThan(1000);
    expect(await boxes()).toBe(0);

    // 窄档仍然有导航入口：② 知识地图在，且是每章末尾「↑ 回知识地图」指向的那个锚点。
    await expect(frame.locator('#map')).toBeVisible();
  });

  // 本组最后一条、这次启动唯一的一次按键（文件头 ⚠️）。先用 scrollTo 停到 #primer
  // （这一步不用键盘），再按唯一的一次 ArrowDown——落点应该正好是第一个幕封页。
  // 停靠点是 `.curtain, .concept, section[id]`，文档序下 #map、#primer 之后就是
  // fixture 插进去的第一张幕封页（v5 删掉「速通路径」之后 #primer 从第 3 个变成第 2 个，
  // 但这条测试不依赖序号，只依赖「幕封页紧跟在 #primer 后面」）。
  //
  // ⚠️ CI 实测：「只按一次」的纪律成立的前提——`page.keyboard.press` 的第一次总能送进
  //    iframe——只在本地成立。CI 上观测到三次首键不达（darwin-x64 round 2 / round 3、
  //    darwin-arm64 round-3 复跑），跟文件头 ⚠️ 里「只有在 frame 里点一下才会再收到一次」
  //    同一个机制：宿主的 activeElement 停在 <iframe> 上，键盘事件没被路由进 OOPIF 文档。
  //    所以这里先在 frame 里真点一下武装键盘投递，按键本身仍然只按一次，禁循环的纪律不变
  //    ——点击不是那一次按键的替代，是它的前提。
  test('46-html-tab: 真模板——ArrowDown 从 #primer 落到第一个幕封页', async () => {
    const { page } = launched;
    const frame = templateFrame();

    // 武装点：#primer 自己（h2 + 一个 <p> + 一个 <dl>，buildTemplateFixture 填进去的
    // 那段，见本文件顶部）——通篇没有 <a> 或表单控件，模板脚本里唯一的 click 监听器
    // 挂在 .toc-head 上（跟 #primer 无关，见 report-template.html 里「左侧导航树」
    // 那段 IIFE）。点在它的左上角，不落在任何子元素的文字上。Playwright 点击前会把
    // 目标滚进视口——这一下滚到哪不重要，下一步紧接着就是程序化 scrollTo 到 #primer，
    // 会把滚动位置整个覆盖掉。
    await frame.locator('#primer').click({ position: { x: 4, y: 4 } });

    const curtain = frame.locator('.curtain').first();
    const topOf = () => curtain.evaluate((el) => el.getBoundingClientRect().top);

    // 停到 #primer 的落点上（offsetTop 减 scroll-margin-top，跟模板脚本里 stopTarget()
    // 同一个算法）。behavior: 'instant' 是必须的：html 上写了 scroll-behavior: smooth，
    // 'auto' 在这份文档里等同 smooth（模板脚本里那条 ⚠️ 记着这次实测）。
    await frame.locator('body').evaluate((el) => {
      const doc = el.ownerDocument;
      const primer = doc.querySelector('#primer') as HTMLElement;
      const target = primer.offsetTop - (parseFloat(getComputedStyle(primer).scrollMarginTop) || 0);
      doc.defaultView!.scrollTo({ top: target, behavior: 'instant' });
    });
    // 前置条件：幕封页此刻还在视口下方——否则下面「落到顶」就不能证明是这次按键干的。
    await expect.poll(topOf).toBeGreaterThan(100);

    await page.keyboard.press('ArrowDown');
    // 判据是幕封页真的停在视口顶（|top| < 40，容得下吸附的微调），不是「按得动」。
    // 停靠点算错（模板脚本里那两个坑：拿 offsetTop 直接比 scrollY、或选择器漏了某类
    // 小节）会落在别的地方，滚过头则是明显的负值，两种都红。
    await expect.poll(async () => Math.round(await topOf()), { timeout: 15_000 })
      .toBeLessThan(40);
    expect(await topOf()).toBeGreaterThan(-40);
  });
});
