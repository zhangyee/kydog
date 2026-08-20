import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchKydog, seedSettings, seedProject, teardown } from './helpers';

const HTML_REL = 'report.html';

// 正文里那个 <script> 是探针：沙箱现在给了 allow-scripts，它应该跑起来
// （#probe 的文字被改成 SCRIPT-RAN），但 CSP 的 connect-src 'none' 应该拦住它发出的请求
// （#net 停在 BLOCKED，不会变成 ALLOWED）。
// #jump / #c1 是页内锚点那条链（知识地图节点 → 章节）；#external 是 DOI 外链那条链；
// #s1 / #s2 / #h2 是方向键翻节那条链——keydown 监听器把 ArrowDown 接到 #s2.scrollIntoView()。
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
<h2 id="c1">第一节</h2>
<section id="s1">第一节</section>
<section id="s2"><h2 id="h2">第二节</h2></section>
<script>
  document.getElementById('probe').textContent = 'SCRIPT-RAN';
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') document.getElementById('s2').scrollIntoView();
  });
  fetch('http://127.0.0.1:9/beacon')
    .then(() => { document.getElementById('net').textContent = 'ALLOWED'; })
    .catch(() => { document.getElementById('net').textContent = 'BLOCKED'; });
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
    await expect(frame.locator('#net')).toHaveText('BLOCKED', { timeout: 10000 });
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
