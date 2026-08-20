import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown } from './helpers';

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
// #reveal-1 / #reveal-2 是入场动效那条链：脚本逐字照抄真实模板 report-template.html
// 里 .reveal 的处理逻辑（IntersectionObserver + prefers-reduced-motion 分支），元素
// 初始 opacity 由脚本设成 0，滚入视口后动画回 1——测的就是"动画写错导致内容永远
// opacity:0"这种静默失败会不会被抓出来。
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
  // 逐字照抄 report-template.html 文末 <script> 里 .reveal 那部分逻辑。
  (() => {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const items = [...document.querySelectorAll('.reveal')];
    if (reduce) { items.forEach((el) => { el.style.opacity = '1'; }); return; }
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
    }, { rootMargin: '0px 0px -12% 0px' });
    items.forEach((el) => io.observe(el));
  })();
  // 连接失败与被 CSP 拦截会产生同样的 TypeError，这里什么都不做——
  // 判据只看上面那个 securitypolicyviolation 事件。
  fetch('http://127.0.0.1:9/beacon').catch(() => {});
</script>
</body>
</html>
`;

async function seedAll(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, HTML_REL), REPORT_HTML);
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

// Task 7b：查看器把报告里的相对路径 <img> 在渲染时内联成 data URI。
// 1x1 透明像素的最小合法 PNG（能被真解码，不是随手拼的假字节）。
const MINIMAL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

// 在 REPORT_HTML 基础上加两张图：#fig 是合法的报告目录内相对路径（应内联成功），
// #bad 是逃出报告目录树的路径（应被拒绝、退化成 alt 文字）。不复用给其余测试的
// REPORT_HTML 常量本身（只在这两条测试用的变体里加），其余测试的断言/时序不受影响。
const REPORT_HTML_WITH_IMAGES = REPORT_HTML.replace(
  '<h1 id="heading">知识地图</h1>',
  '<h1 id="heading">知识地图</h1>\n'
  + '<img id="fig" src="fig.png" alt="架构图">\n'
  + '<img id="bad" src="../outside.png" alt="ALT-FALLBACK">',
);

async function seedWithImages(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, HTML_REL), REPORT_HTML_WITH_IMAGES);
  await fs.writeFile(path.join(projectPath, 'fig.png'), MINIMAL_PNG);
  // 放在 proj/ 外面一级 —— 真实存在、可读，证明拒绝的原因是「逃出目录树」而不是
  // 单纯的「文件不存在」。
  await fs.writeFile(path.join(home, 'outside.png'), MINIMAL_PNG);
  await seedProject(home, projectPath, [{ id: 'thr-1', title: '测试 Thread' }]);
}

test('46-html-tab: 双击打开 HTML tab → 渲染内容', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    await expect(page.locator(`[data-testid="tab-${htmlPath}"]`)).toBeVisible();
    const frame = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`);
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
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`);
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
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`);
    // 判据是 securitypolicyviolation 事件（协议层事实），不是 fetch 失败与否
    // （代理信号——连接被拒和被 CSP 拦截产生同样的 TypeError，见 fixture 里的注释）。
    await expect(frame.locator('#net')).toHaveText(/^CSP-BLOCKED:connect-src/, { timeout: 10000 });
  } finally {
    await teardown(launched);
  }
});

test('46-html-tab: 报告跟随 app 主题', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const body = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`).locator('body');
    const bgOf = () => body.evaluate((el) => getComputedStyle(el).backgroundColor);

    await expect(page.locator(`[data-testid="tab-${htmlPath}"]`)).toBeVisible();
    const before = await bgOf();

    // 走真实 UI 切主题（同 e2e/08-theme-switch.spec.ts 的路径）：
    // 用户菜单 → midnight。注入的 --paper 变了，frame 里的背景必须跟着变。
    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.locator('[data-testid="theme-midnight"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');

    await expect.poll(bgOf).not.toBe(before);
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
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const body = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`).locator('body');
    const sizeVar = () => body.evaluate(
      (el) => getComputedStyle(el).getPropertyValue('--reading-font-size').trim(),
    );

    await expect(page.locator(`[data-testid="tab-${htmlPath}"]`)).toBeVisible();
    await expect.poll(sizeVar).not.toBe('');

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
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`);
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
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`);
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
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`);
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
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`);
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
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`);
    await expect(frame.locator('#heading')).toHaveText('知识地图');
    await expect.poll(() => frame.locator('body').evaluate((el) => el.ownerDocument.readyState)).toBe('complete');

    // 切到 thread tab，再切回 html tab —— 触发 isActive: true → false → true。
    await page.locator('[data-testid="tab-thr-1"]').click();
    await page.locator(`[data-testid="tab-${htmlPath}"]`).click();
    await expect(page.locator(`[data-testid="file-pane-${htmlPath}"]`)).toBeVisible();

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
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`);
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
  const launched = await launchKydog({ seed: seedWithImages });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`);
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
  const launched = await launchKydog({ seed: seedWithImages });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`);
    const bad = frame.locator('#bad');
    await expect.poll(() => bad.evaluate((el) => el.getAttribute('data-kydog-inline'))).toBe('rejected');
    // src 属性被整个摘掉（不是留一个读不到的坏路径），元素靠 alt 退化成文字。
    expect(await bad.evaluate((el) => el.hasAttribute('src'))).toBe(false);
    expect(await bad.evaluate((el) => el.getAttribute('alt'))).toBe('ALT-FALLBACK');
  } finally {
    await teardown(launched);
  }
});
