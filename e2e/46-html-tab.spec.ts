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
// 就等于让 Chromium 替我们解析一遍，再对它自己那三条能力（入场动效、进度条、
// 方向键停靠点）下断言。路径相对 cwd：e2e 由 playwright 从仓库根跑起
// （helpers.ts 传给 electron 的 '.vite/build/main.js' 也是这么解析的）。
const TEMPLATE_REL = 'template.html';
const TEMPLATE_SRC = path.resolve(process.cwd(), 'src/skills/learning-deck/assets/report-template.html');

async function seedAll(home: string) {
  await seedSettings(home);
  const projectPath = path.join(home, 'proj');
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, HTML_REL), REPORT_HTML);
  // 真模板与合成 fixture 并存、各测各的：合成 fixture 的元素 id 与时序是那几条
  // 测试的判据，不能为了「换成真模板」把它们改掉。
  await fs.copyFile(TEMPLATE_SRC, path.join(projectPath, TEMPLATE_REL));
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

// Task 7b review 的 Critical 修复：resolveInlineTarget 只做字符串校验（逃出 baseDir
// 的相对路径、绝对路径），挡不住「路径字符串本身完全合规、实际是个指向目录树外的
// 符号链接」这种向量。这条测试是唯一验证 file.readBytesWithin 那道 realpath 校验
// 真的在端到端链路里生效的证据——单测（fileService.test.ts）只测了 realpath
// 校验函数本身，没有验证 HtmlFileTab → inlineLocalImages → RPC 这条链真的把它接上了。
test('46-html-tab: 报告目录内指向目录外的符号链接被拒绝，不能靠字符串校验绕过', async () => {
  const launched = await launchKydog({ seed: seedWithImages });
  try {
    const { page, kydogHome } = launched;
    const htmlPath = path.join(kydogHome, 'proj', HTML_REL);

    await page.click('text=测试 Thread');
    const fsRow = page.locator(`[data-testid="fs-${htmlPath}"]`);
    await fsRow.waitFor();
    await fsRow.dblclick();

    const frame = page.frameLocator(`[data-testid="html-frame-${htmlPath}"]`);
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
  const fsRow = page.locator(`[data-testid="fs-${templatePath}"]`);
  await fsRow.waitFor();
  await fsRow.dblclick();
  const frame = page.frameLocator(`[data-testid="html-frame-${templatePath}"]`);
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

test('46-html-tab: 真模板——顶部进度条随滚动变宽', async () => {
  const launched = await launchKydog({ seed: seedAll });
  try {
    const { page, kydogHome } = launched;
    const frame = await openTemplate(page, kydogHome);

    const bar = frame.locator('#progress-bar');
    const widthOf = () => bar.evaluate((el: HTMLElement) => el.getBoundingClientRect().width);
    // 载入时脚本跑过一次 update()，scrollY 是 0 ⇒ 宽度 0。
    await expect.poll(widthOf).toBe(0);

    await frame.locator('body').evaluate((el) => { el.ownerDocument.defaultView!.scrollTo(0, 4000); });
    await expect.poll(widthOf).toBeGreaterThan(0);
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
// 于是这条测试先用 scrollTo 停到 #primer（第 3 个停靠点，这一步不用键盘），
// 再按唯一的一次 ArrowDown——落点应该正好是第一个幕封页。
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

// 窄面板（报告面板 < 820px）是 KyDog **默认窗口唯一会走到的那一档**：三栏退化成单栏，
// 左侧目录树退成正文上方一条 sticky 的横条。
//
// 这条锁的是「横条真的**贴得住**」，不是「横条存在」——两者的失败模式完全不同，
// 而且只有滚动之后量 top 才分得清：不滚动时横条本来就在顶上，静态截图看着一样。
//
// 为什么值得单开一条：这一档里 .toc 是网格项、还跟 .flow 分处两行，很容易被按
// 「grid 项的包含块是自己的网格区域，行按内容定高就没有余量可粘」推理成
// 「sticky 在这里不生效」。实测（Chromium 最小复现四种布局 + 本条测试）**是生效的**，
// 模板 CSS 那段 @media 里记着复现的数。这条测试把这个行为钉住：万一哪天
// Chromium 真的改了、或者有人改布局把它弄坏了，这里会先红。
//
// ⚠️ 第二组断言（横条与正文列等宽、左右对齐）不是锦上添花，是这条测试的另一半：
// 只断言纵向贴顶的话，**它区分不了单列 grid 和 display: block** —— 两种实现下横条
// 都贴在 top: 2px，而 display: block 正是模板 CSS 那段 ⚠️ 明令禁止的动作
// （它会把横条从「与正文列等宽 570px」变成「通栏 698px」，跟正文列错开）。
// 反向验证过：临时把窄档改成 display: block，纵向那组仍然绿，**这组变红**
// （实测 toc 698 / flow 570、left 20 vs 84）。别把它删成「只测贴顶」。
test('46-html-tab: 真模板——窄面板下目录横条贴顶且与正文列对齐', async () => {
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
    await expect(toc).toBeVisible();

    await frame.locator('body').evaluate((el) => {
      el.ownerDocument.defaultView!.scrollTo({ top: 1200, behavior: 'instant' });
    });
    await expect
      .poll(() => frame.locator('body').evaluate((el) => el.ownerDocument.defaultView!.scrollY))
      .toBeGreaterThan(1000);

    // ① 纵向：CSS 写的是 sticky top: 2px（让开顶上那条 2px 的 .progress）。
    // 没贴住的话横条已经被滚到视口上方很远，top 会是一个很大的负数。
    const top = await toc.evaluate((el) => el.getBoundingClientRect().top);
    expect(top).toBeGreaterThan(-2);
    expect(top).toBeLessThan(20);

    // ② 横向：横条必须和正文列**等宽、左右对齐**（窄档的 .deck 是单列 grid，
    // 两者共用同一条 minmax(0, --ld-measure) 轨道 + justify-content: center）。
    // 这是唯一能把「单列 grid」和「display: block」区分开的判据，见上面那条 ⚠️。
    const box = await frame.locator('body').evaluate((el) => {
      const doc = el.ownerDocument;
      const t = doc.querySelector('.toc')!.getBoundingClientRect();
      const fl = doc.querySelector('.flow')!.getBoundingClientRect();
      return { tocW: t.width, tocL: t.left, flowW: fl.width, flowL: fl.left };
    });
    expect(Math.abs(box.tocW - box.flowW)).toBeLessThan(1);
    expect(Math.abs(box.tocL - box.flowL)).toBeLessThan(1);
  } finally {
    await teardown(launched);
  }
});
