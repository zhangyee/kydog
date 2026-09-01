import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown, testIdSelector } from './helpers';
import { SKIP_WITHOUT_SYMLINK, SYMLINK_SKIP_REASON } from '../src/test-support/symlinkCapability';

const HTML_REL = 'report.html';

// 正文里那个 <script> 是探针：沙箱现在给了 allow-scripts，它应该跑起来
// （#probe 的文字被改成 SCRIPT-RAN）。
// #net 判据用协议层事实而不是代理信号：`fetch` 请求失败既可能是 CSP 拦截，也可能是
// 单纯连不上 127.0.0.1:9（没人监听），两者在 .catch() 里产生的都是同一个 TypeError ——
// 用 catch 区分不出"CSP 拦了"和"CSP 没拦、只是连接被操作系统拒绝"，会把假绿和真绿混在一起。
// 真正只在 CSP 生效时才发生的协议层事实是 `securitypolicyviolation` 事件，所以 #net
// 只由这个事件驱动，fetch 的 .catch() 什么都不做。
// #jump / #c1 是页内锚点那条链（知识地图节点 → 章节）；#external 是 DOI 外链那条链；
// #s1 / #s2 / #h2 是方向键翻节那条链——keydown 监听器把 ArrowDown 接到 #s2.scrollIntoView()。
// #reveal-1 / #reveal-2 是入场动效那条链：元素初始 opacity 由脚本设成 0，滚入视口后
// 动画回 1——测的就是"动画写错导致内容永远 opacity:0"这种静默失败会不会被抓出来。
// ⚠️ 这段 .reveal 逻辑是**照着真模板写的简化版，不是逐字副本**，别再声称它是（曾经
// 声称过，然后模板改了它没跟上：commit de38b16 把 { rootMargin: '0px 0px -12% 0px' }
// 从模板里删掉，这里还留着，测试照过不误——它锁不住它声称要锁的东西）。真模板由
// 下面「真模板」那几条测试直接 seed 进去验，那才是模板本身的锁；这个合成 fixture
// 只负责它自己那几条（沙箱执行脚本、CSP 拦截、页内锚点、外链、方向键、图片内联），
// 各自的判据都写在对应的测试里。
const REPORT_HTML = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>测试报告</title>
<style>body { background: var(--paper, #ffffff); color: var(--ink, #222222); }
  section { min-height: 120vh; }</style>
</head>
<body>
<h1 id="heading">知识地图</h1>
<p id="probe">SCRIPT-DID-NOT-RUN</p>
<p id="net">NOT-RUN</p>
<p><a id="jump" href="#c1">跳到第一节</a></p>
<p><a id="external" href="https://example.com/10.1000/xyz" target="_blank" rel="noopener">DOI 外链</a></p>
<div style="height: 2400px"></div>
<p class="reveal" id="reveal-1">REVEAL-1</p>
<p class="reveal" id="reveal-2">REVEAL-2</p>
<h2 id="c1">第一节</h2>
<section id="s1">第一节</section>
<section id="s2"><h2 id="h2">第二节</h2></section>
<script>
  document.getElementById('probe').textContent = 'SCRIPT-RAN';
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') document.getElementById('s2').scrollIntoView();
  });
  document.addEventListener('securitypolicyviolation', (e) => {
    document.getElementById('net').textContent = 'CSP-BLOCKED:' + e.violatedDirective;
  });
  // 模板 .reveal 逻辑的简化版（见文件顶部的 ⚠️）：同样的 IntersectionObserver +
  // reduce/hasIO 分支，同样不传 rootMargin / threshold（负的底边会让文档末尾的元素
  // 永久不触发，模板里那条 ⚠️ 写了原委）。
  (() => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const hasIO = typeof IntersectionObserver === 'function';
    const items = [...document.querySelectorAll('.reveal')];
    if (reduce || !hasIO) { items.forEach((el) => { el.style.opacity = '1'; }); return; }
    items.forEach((el) => { el.style.opacity = '0'; });
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        const sibs = [...e.target.parentElement.querySelectorAll(':scope > .reveal')];
        const delay = Math.min(sibs.indexOf(e.target), 6) * 70;
        e.target.animate(
          [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }],
          { duration: 320, delay, easing: 'cubic-bezier(.2,.6,.2,1)', fill: 'forwards' },
        );
      }
    });
    items.forEach((el) => io.observe(el));
  })();
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

async function seedAll(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, HTML_REL), REPORT_HTML);
  // 真模板与合成 fixture 并存、各测各的：合成 fixture 的元素 id 与时序是那几条
  // 测试的判据，不能为了「换成真模板」把它们改掉。
  const template = await fs.readFile(TEMPLATE_SRC, 'utf8');
  await fs.writeFile(path.join(projectPath, TEMPLATE_REL), buildTemplateFixture(template));
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

// Task 7b：查看器把报告里的相对路径 <img> 在渲染时内联成 data URI。
// 1x1 透明像素的最小合法 PNG（能被真解码，不是随手拼的假字节）。
const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

// 在 REPORT_HTML 基础上加三张图：#fig 是合法的报告目录内相对路径（应内联成功），
// #bad 是逃出报告目录树的路径（应被拒绝、退化成 alt 文字），#evil 是报告目录树内
// 的一个符号链接、文件名和路径字符串都合规，但链接目标在树外（Task 7b review
// Critical：resolveInlineTarget 的字符串校验拦不住这个向量，得靠主进程
// file.readBytesWithin 的 realpath 校验拦）。不复用给其余测试的 REPORT_HTML
// 常量本身（只在这几条测试用的变体里加），其余测试的断言/时序不受影响。
const REPORT_HTML_WITH_IMAGES = REPORT_HTML.replace(
  '<h1 id="heading">知识地图</h1>',
  '<h1 id="heading">知识地图</h1>\n'
  + '<img id="fig" src="fig.png" alt="架构图">\n'
  + '<img id="bad" src="../outside.png" alt="ALT-FALLBACK">\n'
  + '<img id="evil" src="evil-link.png" alt="EVIL-FALLBACK">',
);

async function seedWithImages(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, HTML_REL), REPORT_HTML_WITH_IMAGES);
  await fs.writeFile(path.join(projectPath, 'fig.png'), MINIMAL_PNG);
  // 放在 proj/ 外面一级 —— 真实存在、可读，证明拒绝的原因是「逃出目录树」而不是
  // 单纯的「文件不存在」。
  const outsidePath = path.join(home, 'outside.png');
  await fs.writeFile(outsidePath, MINIMAL_PNG);
  // 符号链接放在 proj/ 里面（字符串路径 'evil-link.png' 完全合规、扩展名也在白名单），
  // 但链接目标指向 proj/ 外面的 outside.png —— 字符串校验看不出问题，得靠 realpath。
  await fs.symlink(outsidePath, path.join(projectPath, 'evil-link.png'));
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

test('46-html-tab: 双击打开 HTML tab → 渲染内容', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${htmlPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    await expect(page.getByTestId(`tab-${htmlPath}`)).toBeVisible();
    const frame = page.frameLocator(testIdSelector(`html-frame-${htmlPath}`));
    await expect(frame.locator('#heading')).toHaveText('知识地图');
  } finally {
    await teardown(launched);
  }
});

// v1 安全模型的锚点是「沙箱不执行页面里的脚本」——v2 反过来了：沙箱开了 allow-scripts，
// 脚本能跑，风险改由 CSP 的 connect-src 'none' 兜（见下一条测试）。这条测试改名 + 反转断言
// 留下痕迹，而不是删掉重写一条新的。
test('46-html-tab: 沙箱执行页面里的脚本', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${htmlPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(testIdSelector(`html-frame-${htmlPath}`));
    await expect(frame.locator('#probe')).toHaveText('SCRIPT-RAN');
  } finally {
    await teardown(launched);
  }
});

test('46-html-tab: CSP 拦住脚本的对外请求', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${htmlPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(testIdSelector(`html-frame-${htmlPath}`));
    // 判据是 securitypolicyviolation 事件（协议层事实），不是 fetch 失败与否
    // （代理信号——连接被拒和被 CSP 拦截产生同样的 TypeError，见 fixture 里的注释）。
    await expect(frame.locator('#net')).toHaveText(/^CSP-BLOCKED:connect-src/, { timeout: 10000 });
  } finally {
    await teardown(launched);
  }
});

// 主题 / 阅读字号一变，HtmlFileTab 的注入 effect 就重建 srcDoc，iframe 随即导航，
// 在飞的 evaluate 会以「Execution context was destroyed」收场——那是取早了，不是坏了
// （全量串行跑时机器负载把时序拉开才撞得到，2026-09-01 macOS 观测到一次）。而
// expect.poll 只在断言不匹配时重试，回调抛错会立刻判死，所以两条「跟随」用例得把
// 这类瞬态错误折叠成 null 让 poll 继续等；其他错误照抛，真坏了不许吞。
// 配套纪律：poll 的断言必须是 null 满足不了的正向匹配（toBe('midnight') / toBe('15px')），
// 用 .not.toBe(...) 会把重建期的 null 当成「变了」放过去。
function nullWhileFrameRebuilds<T>(p: Promise<T>): Promise<T | null> {
  return p.catch((err) => {
    if (/Execution context was destroyed|Frame was detached/i.test(String(err))) return null;
    throw err;
  });
}

test('46-html-tab: 报告跟随 app 主题', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${htmlPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const body = page.frameLocator(testIdSelector(`html-frame-${htmlPath}`)).locator('body');
    const bgOf = () => nullWhileFrameRebuilds(
      body.evaluate((el) => getComputedStyle(el).backgroundColor));
    // 主题**身份**（reportTheme.ts 的 REPORT_THEME_ATTR）。转发过去的变量只有颜色的
    // 值，说不出「这是哪一套主题」；报告里按主题语义取色的地方（learning-deck 抬头
    // 那条深色带上的前景色）靠的就是这个属性。没有它，下游只能量亮度去猜——
    // 正是 CLAUDE.md Principles 禁的那种 proxy。
    const themeAttrOf = () => nullWhileFrameRebuilds(body.evaluate((el) =>
      el.ownerDocument.documentElement.getAttribute('data-kydog-theme')));

    await expect(page.getByTestId(`tab-${htmlPath}`)).toBeVisible();
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
  } finally {
    await teardown(launched);
  }
});

test('46-html-tab: 报告跟随阅读字号', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${htmlPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const body = page.frameLocator(testIdSelector(`html-frame-${htmlPath}`)).locator('body');
    const sizeVar = () => nullWhileFrameRebuilds(body.evaluate(
      (el) => getComputedStyle(el).getPropertyValue('--reading-font-size').trim(),
    ));

    await expect(page.getByTestId(`tab-${htmlPath}`)).toBeVisible();
    // medium 档的值（globals.css :root），正向断言：重建期的 null / 初始 about:blank
    // 的空串都满足不了它，poll 会一直等到注入完的文档。
    await expect.poll(sizeVar).toBe('15px');

    // 同 e2e/36-font-size.spec.ts 的路径：用户菜单 → 大号
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="reading-size-large"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-reading-size', 'large');

    await expect.poll(sizeVar).toBe('17px');
  } finally {
    await teardown(launched);
  }
});

test('46-html-tab: 文件内容改了 tab 自动重载', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${htmlPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(testIdSelector(`html-frame-${htmlPath}`));
    await expect(frame.locator('#heading')).toHaveText('知识地图');

    // 从进程外改写文件 —— 模拟 agent 重写报告
    await fs.writeFile(htmlPath, REPORT_HTML.replace('知识地图', '知识地图 v2'));

    await expect(frame.locator('#heading')).toHaveText('知识地图 v2', { timeout: 10000 });
  } finally {
    await teardown(launched);
  }
});

test('46-html-tab: 点页内锚点滚到对应章节', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${htmlPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(testIdSelector(`html-frame-${htmlPath}`));
    await expect(frame.locator('#heading')).toHaveText('知识地图');

    // srcdoc 文档的 base URL 继承自宿主，不钉死的话 href="#c1" 被当成跨文档导航：
    // packaged（file://）下静默什么都不发生，dev（http://）下整个 frame 导航去宿主页面。
    // 这两种失败都是静默的，所以断言要落在「真的滚起来了」而不是「点得动」。
    const view = () => frame.locator('body').evaluate((el) => {
      const win = el.ownerDocument.defaultView!;
      return { scrollY: win.scrollY, url: win.location.href };
    });

    await expect.poll(() => frame.locator('body').evaluate((el) => el.ownerDocument.readyState)).toBe('complete');
    expect(await view()).toEqual({ scrollY: 0, url: 'about:srcdoc' });

    // 点击放进 poll 里重试：frame 刚建好那一小段时间里，第一次合成点击偶尔会被吞掉
    // （实测约 1/4，紧接着再点必中）。锚点点了不动是幂等的，重试不改变语义。
    await expect.poll(async () => {
      await frame.locator('#jump').click();
      return (await view()).scrollY;
    }, { timeout: 10_000 }).toBeGreaterThan(0);
    // frame 还待在自己的文档里（没被导航到宿主页面），只是加了个片段
    expect((await view()).url).toBe('about:srcdoc#c1');
    await expect(frame.locator('#c1')).toBeInViewport();
  } finally {
    await teardown(launched);
  }
});

test('46-html-tab: 报告里的外链交给系统浏览器打开', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { app, page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    // 这条链是 sandbox 的 allow-popups → main.ts 的 setWindowOpenHandler → shell.openExternal。
    // 在主进程里把最后一环换成记账，中间任何一环被「少给一个权限更好」收紧掉都会红。
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as unknown as { __openedExternal: string[] }).__openedExternal = opened;
      shell.openExternal = (url: string) => { opened.push(url); return Promise.resolve(); };
    });

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${htmlPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(testIdSelector(`html-frame-${htmlPath}`));
    await expect(frame.locator('#external')).toBeVisible();
    await expect.poll(() => frame.locator('body').evaluate((el) => el.ownerDocument.readyState)).toBe('complete');

    // 同上：点击放进 poll 里重试，第一次点击偶尔会在 frame 刚建好时被吞掉。
    // 断言落在「URL 原样到了 shell.openExternal」，allow-popups 被拿掉的话
    // 这里怎么点都不会有记录，10 秒后变红。
    await expect.poll(async () => {
      await frame.locator('#external').click();
      return app.evaluate(() => (globalThis as unknown as { __openedExternal: string[] }).__openedExternal);
    }, { timeout: 10_000 }).toContain('https://example.com/10.1000/xyz');
  } finally {
    await teardown(launched);
  }
});

test('46-html-tab: 方向键在节间跳转', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${htmlPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(testIdSelector(`html-frame-${htmlPath}`));
    await expect(frame.locator('#heading')).toHaveText('知识地图');
    await expect.poll(() => frame.locator('body').evaluate((el) => el.ownerDocument.readyState)).toBe('complete');

    // 不点击：验的就是 HtmlFileTab 里 srcDoc 就绪后对 iframe 调 .focus() 是否真的让
    // 方向键免点击生效。
    await page.keyboard.press('ArrowDown');
    await expect.poll(() =>
      frame.locator('#h2').evaluate((el) => el.getBoundingClientRect().top),
    ).toBeLessThan(200);
  } finally {
    await teardown(launched);
  }
});

// 锁住 focus effect 的 isActive 依赖：tab 是保持挂载、用 display 切换可见的
// （MainPane.tsx），只依赖 srcDoc 的话，切走再切回来 srcDoc 不变，effect 不重跑，
// 焦点在 display:none 期间已经丢了——方向键会退化回「要先点一下」。没有这条测试，
// 这个退化是静默的：上一条「方向键在节间跳转」只验了 dblclick 那一刻。
test('46-html-tab: 方向键在节间跳转（切走再切回）', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${htmlPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(testIdSelector(`html-frame-${htmlPath}`));
    await expect(frame.locator('#heading')).toHaveText('知识地图');
    await expect.poll(() => frame.locator('body').evaluate((el) => el.ownerDocument.readyState)).toBe('complete');

    // 切到 thread tab，再切回 html tab —— 触发 isActive: true → false → true。
    await page.locator('[data-testid="tab-thr-1"]').click();
    await page.getByTestId(`tab-${htmlPath}`).click();
    await expect(page.getByTestId(`file-pane-${htmlPath}`)).toBeVisible();

    // 不点击：切回来那次 isActive effect 应该重新把焦点交给 iframe。
    await page.keyboard.press('ArrowDown');
    await expect.poll(() =>
      frame.locator('#h2').evaluate((el) => el.getBoundingClientRect().top),
    ).toBeLessThan(200);
  } finally {
    await teardown(launched);
  }
});

// 入场动效唯一能造成灾难的失败模式：.reveal 元素的 opacity 由脚本主动设成 0，
// 靠 IntersectionObserver 在滚入视口时动画回 1——如果这条链路哪里写错（observer
// 没触发、动画目标写反、条件判断反了……），内容会永远停在 opacity: 0，且不报错。
// 这条测试锁的就是这个：滚到 .reveal 元素之后必须最终可见、且 opacity 真的回到了
// 1，不是"滚得到/点得动"这类代理信号。比动效好不好看重要得多。
test('46-html-tab: 入场动效——滚到 .reveal 元素后最终可见', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${htmlPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(testIdSelector(`html-frame-${htmlPath}`));
    await expect(frame.locator('#heading')).toHaveText('知识地图');
    await expect.poll(() => frame.locator('body').evaluate((el) => el.ownerDocument.readyState)).toBe('complete');

    const opacityOf = (loc: ReturnType<typeof frame.locator>) =>
      loc.evaluate((el) => getComputedStyle(el).opacity);

    const reveal1 = frame.locator('#reveal-1');
    const reveal2 = frame.locator('#reveal-2');

    // 滚入视口前：脚本已经跑过、opacity 应该是 0（否则下面滚进去看到"从头到尾都是 1"
    // 就分不清是脚本压根没跑（好的失败模式：至少可见）还是真的做完了淡入淡出）。
    await expect.poll(() => opacityOf(reveal1)).toBe('0');

    await reveal1.scrollIntoViewIfNeeded();
    await expect(reveal1).toBeVisible();
    await expect.poll(() => opacityOf(reveal1)).toBe('1');

    await reveal2.scrollIntoViewIfNeeded();
    await expect(reveal2).toBeVisible();
    await expect.poll(() => opacityOf(reveal2)).toBe('1');
  } finally {
    await teardown(launched);
  }
});

test('46-html-tab: 报告目录内的本地图片渲染时内联成 data URI', async () => {
  test.skip(SKIP_WITHOUT_SYMLINK, SYMLINK_SKIP_REASON);
  const launched = await launchKydog({ seed: seedWithImages });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${htmlPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(testIdSelector(`html-frame-${htmlPath}`));
    const fig = frame.locator('#fig');
    await expect(fig).toBeVisible();

    // src 以 data:image/png;base64, 开头只证明字符串被替换了——那怕替换成的是垃圾字节
    // 这条也能过。真正证明"内联出来的字节确实是一张能被浏览器解码的图"的是
    // naturalWidth > 0：解码失败的 <img> naturalWidth 恒为 0。两条都要断言。
    await expect.poll(() => fig.evaluate((el: HTMLImageElement) => el.src)).toMatch(/^data:image\/png;base64,/);
    await expect.poll(() => fig.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  } finally {
    await teardown(launched);
  }
});

test('46-html-tab: 逃出报告目录的图片路径被拒绝，退化成 alt 文字', async () => {
  test.skip(SKIP_WITHOUT_SYMLINK, SYMLINK_SKIP_REASON);
  const launched = await launchKydog({ seed: seedWithImages });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${htmlPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(testIdSelector(`html-frame-${htmlPath}`));
    const bad = frame.locator('#bad');
    await expect.poll(() => bad.evaluate((el) => el.getAttribute('data-kydog-inline'))).toBe('rejected');
    // src 属性被整个摘掉（不是留一个读不到的坏路径），元素靠 alt 退化成文字。
    expect(await bad.evaluate((el) => el.hasAttribute('src'))).toBe(false);
    expect(await bad.evaluate((el) => el.getAttribute('alt'))).toBe('ALT-FALLBACK');
  } finally {
    await teardown(launched);
  }
});

// Task 7b review 的 Critical 修复：resolveInlineTarget 只做字符串校验（逃出 baseDir
// 的相对路径、绝对路径），挡不住「路径字符串本身完全合规、实际是个指向目录树外的
// 符号链接」这种向量。这条测试是唯一验证 file.readBytesWithin 那道 realpath 校验
// 真的在端到端链路里生效的证据——单测（fileService.test.ts）只测了 realpath
// 校验函数本身，没有验证 HtmlFileTab → inlineLocalImages → RPC 这条链真的把它接上了。
test('46-html-tab: 报告目录内指向目录外的符号链接被拒绝，不能靠字符串校验绕过', async () => {
  test.skip(SKIP_WITHOUT_SYMLINK, SYMLINK_SKIP_REASON);
  const launched = await launchKydog({ seed: seedWithImages });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.getByTestId(`fs-${htmlPath}`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(testIdSelector(`html-frame-${htmlPath}`));
    const evil = frame.locator('#evil');
    await expect.poll(() => evil.evaluate((el) => el.getAttribute('data-kydog-inline'))).toBe('rejected');
    expect(await evil.evaluate((el) => el.hasAttribute('src'))).toBe(false);
    expect(await evil.evaluate((el) => el.getAttribute('alt'))).toBe('EVIL-FALLBACK');
  } finally {
    await teardown(launched);
  }
});

// ── 真模板（src/skills/learning-deck/assets/report-template.html）────────────
//
// 上面那些用的是合成 fixture，锁的是查看器（沙箱、CSP、锚点、外链、图片内联）。
// 下面这三条 seed 的是**真模板本身**，锁的是模板文末那个唯一的 <script> 块真的把
// 它承诺的三件事做到了：逐条入场 / SVG 描边、顶部进度条、方向键沿停靠点前进。
// 在这之前仓库里没有任何东西解析过这份文件——脚本块里写出语法错误也不会有测试变红，
// 而它是给 agent 逐字照抄的模板，坏了就是每份报告都坏。

/** 打开真模板那个 tab，返回它的 frameLocator（等到脚本已经跑完）。 */
async function openTemplate(page: Awaited<ReturnType<typeof launchKydog>>['page'], kydogHome: string) {
  const templatePath = path.join(kydogHome, 'proj', TEMPLATE_REL);
  await page.click('text=测试 Thread');
  const fsRow = page.getByTestId(`fs-${templatePath}`);
  await fsRow.waitFor();
  await fsRow.dblclick();
  const frame = page.frameLocator(testIdSelector(`html-frame-${templatePath}`));
  await expect(frame.locator('.deck-head h1')).toBeVisible();
  await expect
    .poll(() => frame.locator('body').evaluate((el) => el.ownerDocument.readyState))
    .toBe('complete');
  return frame;
}

test('46-html-tab: 真模板——.reveal 滚入视口后可见，.draw 路径描完', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const frame = await openTemplate(page, kydogHome);

    const reveal = frame.locator('.reveal').first();
    const opacity = () => reveal.evaluate((el) => getComputedStyle(el).opacity);
    // 先确认脚本真的把它压成了 0——否则下面「最终是 1」分不清是做完了淡入，
    // 还是脚本压根没跑（那种失败模式下元素本来就一直是 1）。
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
  } finally {
    await teardown(launched);
  }
});

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
test('46-html-tab: 真模板——滚动时目录当前项跟着走', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const frame = await openTemplate(page, kydogHome);

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
  } finally {
    await teardown(launched);
  }
});

// ⚠️ 一条测试里只能按**一次**方向键。实测（本轮调试）：`page.keyboard.press` 只有第一次
// 会被送进这个 sandbox srcdoc iframe 的文档，第二次开始 iframe 里的 keydown 计数器就不再
// 增加——宿主的 document.activeElement 自始至终都是那个 <iframe> 元素，重新 .focus() 也
// 救不回来（只有在 frame 里点一下才会再收到一次）。这是 Playwright/Electron 往
// OOPIF 送键盘事件的限制，不是模板的行为，所以别把它写成「多按几次」的循环，
// 那种测试会停在第二个停靠点上永远超时。上面那条合成 fixture 的方向键测试同样只按一次。
//
// 于是这条测试先用 scrollTo 停到 #primer（这一步不用键盘），
// 再按唯一的一次 ArrowDown——落点应该正好是第一个幕封页。
// 停靠点是 `.curtain, .concept, section[id]`，文档序下 #map、#primer 之后就是
// fixture 插进去的第一张幕封页（v5 删掉「速通路径」之后 #primer 从第 3 个变成第 2 个，
// 但这条测试不依赖序号，只依赖「幕封页紧跟在 #primer 后面」）。
test('46-html-tab: 真模板——ArrowDown 从 #primer 落到第一个幕封页', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const frame = await openTemplate(page, kydogHome);

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
  } finally {
    await teardown(launched);
  }
});

// v5 的两跳引用：正文 .source 里的 <a href="#r-…"> 先落到 ⑨ 参考文献那条 <li>，
// 那条 <li> 里的 a.ref-link 才通向论文原 URL。v4 是正文直接外链，点一下就跳出 app。
//
// 为什么值得单开一条：这条链依赖的是**查看器注入的 <base href="about:srcdoc">**
// （srcdoc 文档的 base URL 本来继承宿主，href="#x" 会被当成跨文档导航——
// packaged 下静默无事，dev 下整个 frame 导航去宿主页面）。两种失败都不报错，
// 所以断言落在「真的滚到那条 <li> 了」和「:target 底色真的上了」，不是「点得动」。
test('46-html-tab: 真模板——正文引用两跳落到参考文献那一条', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const frame = await openTemplate(page, kydogHome);

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
    // （那条链本身由「报告里的外链交给系统浏览器打开」那条测试覆盖）。
    await expect(item.locator('a.ref-link')).toHaveAttribute('target', '_blank');
    await expect(item.locator('a.ref-link')).toHaveAttribute('rel', 'noopener');
  } finally {
    await teardown(launched);
  }
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
// 才存在，在模板上断言不了。方向键那条路径由本文件另外两条测试守着。
test('46-html-tab: 真模板——窄面板下不显示顶部目录横条', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const frame = await openTemplate(page, kydogHome);

    // 前置条件：报告面板真的落在窄档。默认窗口 1280px、左会话列表 260 + 右 Inspector 280，
    // 面板约 738px。哪天这几个默认值变了，这条断言会先红，提醒回来重看这条测试。
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
  } finally {
    await teardown(launched);
  }
});
