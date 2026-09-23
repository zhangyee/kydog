import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type LaunchedApp = { app: ElectronApplication; page: Page; userDataDir: string; kydogHome: string };

/**
 * 把一个 testid 拼成 CSS 属性选择器，并转义值里的反斜杠。
 *
 * 别直接写 `[data-testid="${绝对路径}"]`：**反斜杠在 CSS 属性值里是转义符**，
 * Windows 路径里的 `\a`（admin）、`\A`（AppData）会被当成字符转义吃掉，选择器永远
 * 匹配不上 —— 而元素其实渲染得好好的，位置尺寸都正常，看起来就像"功能坏了"。
 * POSIX 路径全是正斜杠，所以这个坑只在 Windows 上炸，macOS/Linux 上两种写法等价。
 *
 * 能用 `page.getByTestId()` 的地方优先用它（Playwright 自己会转义）；这个函数是给
 * `frameLocator()` 之类只收选择器字符串的 API 用的。
 */
export function testIdSelector(testId: string): string {
  return `[data-testid="${testId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
}

export async function launchKydog(opts: {
  fixture?: string;
  /**
   * 逐页翻译响应的 fixture 路径（→ `KYDOG_TRANSLATE_FIXTURE`）。设了它，主进程的
   * `pdf.translation.layout` / `pdf.translation.translate`（两步协议，spec 2026-09-07 §4）就从
   * 这份 JSON 里按页、按调用顺序取响应，不碰上游模型——但仍走同一个 semaphore 与同一条并发路径
   * （src/main/pdf/pdfTranslatePage.ts）。格式见 e2e/fixtures/translate/。
   */
  translateFixture?: string;
  seed?: (kydogHome: string) => Promise<void>;
  /** Extra env vars merged into the launched Electron process (e.g. KYDOG_E2E, KYDOG_OAUTH_FIXTURE). */
  env?: Record<string, string>;
  /** true = 全新 HOME 不预置（onboarding 专项用）。默认自动预置"已完成 onboarding"。 */
  freshHome?: boolean;
  /** 传入则复用该 HOME（重启场景）。 */
  kydogHome?: string;
} = {}): Promise<LaunchedApp> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-userdata-'));
  const kydogHome = opts.kydogHome ?? await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-home-'));
  if (!opts.freshHome && !opts.kydogHome) await seedSettings(kydogHome);
  if (opts.seed) await opts.seed(kydogHome);
  const env: Record<string, string> = {
    ...process.env,
    HOME: kydogHome,
    USERPROFILE: kydogHome,
    KYDOG_LOG: 'warn',
    KYDOG_E2E: '1',
    // pi 自己的断网开关。不设的话启动时那次后台目录刷新会真去 pi.dev 拉一份**当天的**模型
    // 清单，而退役模型是按这份清单过滤掉的（`KydogModelsStore.liveModelIds`）——夹具里写死
    // 的 claude-sonnet-4-5 / gpt-4o 哪天在上游下架，这些用例就在一台联网的机器上红、在断网
    // 的机器上绿。单测的 vitest.config.ts 出于同样的理由也设了它。
    PI_OFFLINE: '1',
    ...(opts.env ?? {}),
  };
  if (opts.fixture) env.KYDOG_AGENT_FIXTURE = opts.fixture;
  if (opts.translateFixture) env.KYDOG_TRANSLATE_FIXTURE = opts.translateFixture;
  const app = await electron.launch({
    // --force-prefers-no-reduced-motion：OOPIF 进程创建时快照 OS 层 reduce，CDP 仿真
    // 按构造晚于模板 parse，所以必须用进程级开关在信号入口换源；一处覆盖主 frame 与
    // 沙箱 iframe。上一轮（fix wave B）加过 page.emulateMedia({ reducedMotion:
    // 'no-preference' })，已证明形同虚设：主 frame 本来就被 Playwright 连接时无条件钉在
    // no-preference（那次调用是多余的），沙箱报告 iframe 是独立 renderer 进程
    // （OOPIF），CDP 仿真要等 Playwright auto-attach 之后才落地，而模板内联脚本在 parse
    // 期就已把 reduce 读进 const 并选定分支——晚到即永久走错分支。CI runner 镜像默认
    // prefers-reduced-motion: reduce，于是所有断言动效的用例（reveal/draw/marquee）在
    // CI 上永远等不到动画。这个开关在信号进入 Chromium 的那一层（gfx::Animation）就把它
    // 换成确定的 no-preference，先于一切 parse，因此删掉了那行 emulateMedia。本地 OS
    // 本来就是 no-preference，行为不变；要测 reduce 行为的用例应自行
    // emulateMedia({ reducedMotion: 'reduce' }) 显式声明（对主 frame 仍然生效）。
    // --force-device-scale-factor=1：把 canvas 的**器件像素**钉死，与上面那条同一类做法
    // （在信号入口换源，而不是在下游补救）。开发机是 Retina（dpr 2），CI 的 macOS runner
    // 是 dpr 1，同一份 PDF 在两边画进 canvas 的像素数差一倍——凡是逐像素采样的判据（降部
    // 那条带、块内溢出）在开发机上采得到、在 CI 上就落进不足一个像素的亚像素里被抗锯齿抹平。
    // 判据本身没问题，是量它的分辨率被环境偷偷改了。钉住之后两边量的是同一张位图。
    // -AppleShowScrollBars Always（仅 macOS）：把滚动条钉成常驻，理由同上。系统设置默认
    // 「按鼠标或触控板自动」：有触控板的开发机是浮动滚动条（宽 0），CI 的 macOS runner 没有
    // 触控板，画的是 15px 常驻滚动条（Windows 一直是常驻的）。凡是量到页面右缘的判据，两边
    // 差的就是这一条滚动条 —— v0.4.0 的 tag run 上 61-browser 的 1:1 那条在 CI 停在 1275.11、
    // 本机到 1280，就是它。这是 NSUserDefaults 的参数域，只作用于被启动的这个进程，不碰系统设置。
    args: [
      '.vite/build/main.js',
      '--force-prefers-no-reduced-motion',
      '--force-device-scale-factor=1',
      ...(process.platform === 'darwin' ? ['-AppleShowScrollBars', 'Always'] : []),
      `--user-data-dir=${userDataDir}`,
    ],
    env,
    timeout: 20_000,
  });
  const page = await app.firstWindow();
  // 窗口尺寸也钉死，理由同 --force-device-scale-factor。
  //
  // 应用自己按 1280×800 建窗，但**这个尺寸不由应用说了算**：CI 的 macOS runner 屏幕只有
  // 1024×768，系统会把窗口压到屏幕内。于是同一份代码在开发机上跑的是 1280 宽、CI 上是 1024
  // 宽，PDF 对照的每一栏差着一百多像素，逐像素与逐几何的判据两边量的根本不是同一个东西
  // （v0.3.0 的三轮 tag run：本机全绿、CI 上八条红，全部指向这一处）。
  //
  // 钉成 1024×720：宽度取 CI 那台的屏宽（再宽在 CI 上钉不住），高度留出菜单栏与窗口边框的
  // 余量。两边从此量同一个版面。要测别的尺寸的用例自己 setBounds，不要改这里。
  await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    if (w) w.setBounds({ x: 0, y: 0, width: 1024, height: 720 });
  });
  // launchKydog 的返回契约：应用已启动完成并渲染出真实 UI（不是还停在 bootstrap 前的
  // "KYDOG" 占位闪屏）。没有这道锚，每条 spec 的首个断言都在用 5 秒的行为判据替启动方差
  // 买单——冷 runner 上首帧超 5s 就红（50/00/10/36/18 各中过一次，跨五轮 CI 与本地）。这里
  // 的 30s 是启动 infra 预算（config 注释：「光 launch 就允许 20s」同类），行为判据的 5s
  // expect.timeout 一毫米不动。
  //
  // Root() 落地后只会二选一：onboarding 未完成 → OnboardingWizard（[data-testid=
  // "onboarding-root"]，freshHome:true / onboardingCompleted:false 都走这条），否则 →
  // AppShell/ThreeColumnLayout（[data-pane="workspace"]，包括 providerConfigured:false ——
  // 那只是强制切到设置 tab，左侧工作区栏照常渲染）。两者互斥，任一时刻只有其中一个存在于
  // DOM，selector list 里用哪个都不会撞 strict-mode；`.first()` 只是兜个底。
  await page
    .locator('[data-pane="workspace"], [data-testid="onboarding-root"]')
    .first()
    .waitFor({ timeout: 30_000 });
  return { app, page, userDataDir, kydogHome };
}

export async function seedSettings(kydogHome: string, opts: { providerConfigured?: boolean; onboardingCompleted?: boolean; locale?: 'zh' | 'en' } = {}) {
  await fs.mkdir(path.join(kydogHome, '.kydog'), { recursive: true });
  const v4 = {
    schemaVersion: 4 as const,  // 故意留在 v4：让 e2e 每次都走一遍 v4 → v9 迁移
    ui: {
      theme: 'vellum',
      locale: opts.locale ?? 'zh',
      workspaceCollapsed: false,
      inspectorCollapsed: false,
      readingFontSize: 'medium',
    },
    llm: opts.providerConfigured === false
      ? { auth: {}, providers: {}, customProviders: [], defaultProvider: null, defaultModel: null }
      : {
          auth: { 'anthropic': { type: 'api_key', key: 'sk-fix' } },
          providers: { 'anthropic': {} },
          customProviders: [],
          defaultProvider: 'anthropic',
          defaultModel: 'claude-sonnet-4-5',
        },
    skills: { disabledBuiltins: [] },
    tools: { externalBins: [] },
    onboarding: { completedAt: opts.onboardingCompleted === false ? null : '2026-01-01T00:00:00.000Z' },
  };
  await fs.writeFile(
    path.join(kydogHome, '.kydog', 'kydog.json'),
    JSON.stringify(v4, null, 2),
  );
}

export async function seedProject(kydogHome: string, projectPath: string, threads: Array<{ id: string; title: string }> = []) {
  await fs.mkdir(path.join(kydogHome, '.kydog'), { recursive: true });
  await fs.writeFile(
    path.join(kydogHome, '.kydog', 'index.json'),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: projectPath, addedAt: new Date().toISOString() }],
      threads: threads.map((t) => ({
        id: t.id,
        projectPath,
        title: t.title,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      })),
    }, null, 2),
  );
}

export async function seedSamplePackage(projectPath: string) {
  await fs.mkdir(projectPath, { recursive: true });
  await fs.writeFile(path.join(projectPath, 'README.md'), '# sample\n');
  await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
  await fs.writeFile(path.join(projectPath, 'src', 'a.ts'), 'export const a = 1;\n');
}

export async function teardown(launched: LaunchedApp): Promise<void> {
  await launched.app.close();
  await fs.rm(launched.userDataDir, { recursive: true, force: true }).catch(() => {});
}

/**
 * 点「新对话」并等它真的切过去，返回新对话的 id。
 *
 * `thread.create` 是异步 RPC：返回之前页面上还是上一个对话的输入框，这时填字会填进旧的那个，
 * 切过去之后新输入框是空的、发送键一直禁用（CI 上见过 30s 超时）。判据是输入框所属的对话
 * （Composer 根节点的 `data-thread-id`）换成了一个没见过的 id —— 不是等一个时间。
 */
export async function newThread(page: Page): Promise<string> {
  const composer = page.locator('[data-thread-id]');
  const before = (await composer.count()) > 0 ? await composer.first().getAttribute('data-thread-id') : null;
  await page.getByTestId('new-thread').click();
  let id: string | null = null;
  await expect.poll(async () => {
    id = (await composer.count()) === 1 ? await composer.getAttribute('data-thread-id') : null;
    return id !== null && id !== before;
  }, { message: `「新对话」之后输入框应当属于一个新对话（之前是 ${before}）` }).toBe(true);
  return id!;
}
