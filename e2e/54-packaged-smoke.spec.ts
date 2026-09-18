import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promises as fs, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { promisify } from 'node:util';
import { builtinModules } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { seedSettings } from './helpers';

const execFileP = promisify(execFile);
const repoRoot = path.resolve(__dirname, '..');

// 这是 infra 预算（冷 CI 首启 + 打包应用 + 一次 500MB 整目录复制），不是行为判据；
// expect.timeout 的 5s 紧判据不受影响。内部预算加总（复制 + 30s 启动 + 15s 首页 +
// 3×5s 三栏断言 + 15s 投影 poll + 5s 收尾 + 15s fastpaper）逼近 playwright.config.ts
// 的全局 60s，冷 CI（如 windows-latest 首次 Defender 扫描）撞上限是基础设施抖动，
// 不是产品判据。
test.setTimeout(180_000);

// 打包成品在 out/ 里的落点（electron-forge package / make 的输出布局）。
// 二进制缺失时直接红、报错指路——不做 skipIf：静默跳过会让「打包成品层」的覆盖
// 在流水线上无声消失，与 KYDOG_REQUIRE_SYMLINK 的教训同型。
function builtPaths(): { appDir: string; exeRel: string; resourcesRel: string } {
  if (process.platform === 'darwin') {
    return {
      appDir: path.join(repoRoot, 'out', `KyDog-darwin-${process.arch}`),
      exeRel: path.join('KyDog.app', 'Contents', 'MacOS', 'KyDog'),
      resourcesRel: path.join('KyDog.app', 'Contents', 'Resources'),
    };
  }
  return {
    appDir: path.join(repoRoot, 'out', 'KyDog-win32-x64'),
    exeRel: 'KyDog.exe',
    resourcesRel: 'resources',
  };
}

// 成品必须在**仓库之外**启动，否则这条用例是假绿。
//
// Node 解析 bare specifier（`import('@earendil-works/pi-coding-agent')`）时会从模块
// 所在目录逐级上溯找 node_modules。out/ 就在仓库里，<repo>/node_modules 正好在上溯
// 路径上——成品哪怕一个依赖都没带进去，在开发机和 CI 上也照样跑得起来，借的是开发树
// 的货。2026-09-02 的事故就是这么漏出去的：三平台 CI 全绿，装到 %LOCALAPPDATA% 一开
// 就是 ERR_MODULE_NOT_FOUND，ProviderRegistry.build() 在启动 await 链上，应用开机即死。
//
// 复制到 tmpdir 再启动，把这条逃生路径掐掉：那里的祖先目录不含任何 node_modules，
// 解析得到的东西只能来自包内。

// 复制出来的这份成品有 500MB，用例成败都要收掉，别在 runner 上堆盘。
let stagedRoot: string | null = null;
test.afterEach(async () => {
  if (stagedRoot) await fs.rm(stagedRoot, { recursive: true, force: true }).catch(() => {});
  stagedRoot = null;
});

async function stageOutsideRepo(appDir: string): Promise<string> {
  stagedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-smoke-app-'));
  // tmpdir 落在仓库里（有人把 TMP 指进工作区）这条用例就退回假绿，而且是无声的。
  // 宁可在这里红。
  const rel = path.relative(repoRoot, stagedRoot);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    throw new Error(`tmpdir 在仓库内（${stagedRoot}），成品仍能上溯到 <repo>/node_modules；换一个 TMPDIR`);
  }
  const staged = path.join(stagedRoot, path.basename(appDir));
  // verbatimSymlinks：macOS 的 .app 里 Frameworks/Versions 全是相对软链，默认那套
  // 「解析成绝对路径」会让复制出来的成品指回 out/——等于没搬出仓库。
  await fs.cp(appDir, staged, { recursive: true, verbatimSymlinks: true });
  return staged;
}

// app.asar 的最小读取器：8 字节 pickle 头 + 4 字节头长度 + JSON 文件表，之后是数据区。
// 不引 @electron/asar —— 它只是 @electron/packager 的传递依赖，e2e 直接 require 等于
// 把没在 package.json 里声明的包当接口用。这里只要文件表和取一个文件的内容。
type AsarNode = { files?: Record<string, AsarNode>; size?: number; offset?: string };
function readAsar(file: string): {
  read(p: string): string | null;
  has(p: string): boolean;
  list(prefix: string): string[];
} {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    readSync(fd, head, 0, 16, 0);
    const headerLen = head.readUInt32LE(12);
    const headerBuf = Buffer.alloc(headerLen);
    readSync(fd, headerBuf, 0, headerLen, 16);
    const root = JSON.parse(headerBuf.toString('utf8')) as AsarNode;
    const dataBase = 16 + headerLen;
    const at = (p: string): AsarNode | null => {
      let node: AsarNode | undefined = root;
      for (const seg of p.split('/')) {
        node = node?.files?.[seg];
        if (!node) return null;
      }
      return node;
    };
    return {
      has: (p) => at(p) !== null,
      list: (prefix: string) => {
        const out: string[] = [];
        const walk = (node: AsarNode, p: string) => {
          for (const [name, child] of Object.entries(node.files ?? {})) {
            if (child.files) walk(child, `${p}/${name}`);
            else out.push(`${p}/${name}`);
          }
        };
        const start = at(prefix);
        if (start) walk(start, prefix);
        return out;
      },
      // 每次现开现关：文件表已经在内存里，句柄不必跨调用活着（活着就得管生命周期，
      // 上一版把它 finally 掉了，read() 一调就 EBADF）。
      read: (p) => {
        const node = at(p);
        if (!node || node.size === undefined || node.offset === undefined) return null;
        const buf = Buffer.alloc(node.size);
        const rfd = openSync(file, 'r');
        try {
          readSync(rfd, buf, 0, node.size, dataBase + Number(node.offset));
        } finally {
          closeSync(rfd);
        }
        return buf.toString('utf8');
      },
    };
  } finally {
    closeSync(fd);
  }
}

// 产物里剩下的第三方 bare specifier。vite 把绝大多数依赖打进 bundle，
// external 的那几个以裸名留在产物里，运行时才按 Node 的规则去找 node_modules。
const BARE_SPECIFIER = /(?:\brequire\(|\bimport\(|\bfrom\s*)["']([^"'./][^"']*)["']/g;
function thirdPartySpecifiers(source: string): Set<string> {
  const found = new Set<string>();
  for (const m of source.matchAll(BARE_SPECIFIER)) {
    const spec = m[1];
    if (spec === 'electron' || spec.startsWith('node:')) continue;
    const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (builtinModules.includes(pkg)) continue;
    found.add(pkg);
  }
  return found;
}

// 启动打包二进制并等 CDP 端口。生产 fuse 拦死 electron.launch（注入的 --inspect=0
// 被 EnableNodeCliInspectArguments: false 拒收，表现为 launch 超时），所以走
// spawn + --remote-debugging-port=0，从 stderr 的 DevTools listening 行取端口。
// --use-mock-keychain：绕开 electron.launch 走这条路后，也绕开了 Playwright 内部
// 给 Electron/Chromium 悄悄加的这个测试开关——没有它，macOS 上给一个全新 $HOME
// （没有既存 login keychain）时，Chromium 的 os_crypt 会同步调 Keychain 去创建
// 默认钥匙串，弹交互式 Authorization UI；无人可点的环境下主线程卡死在那次
// mach_msg 上，DevTools 的 HTTP 端点跟着一起没响应——connectOverCDP 超时，
// 但看 stderr 会以为「DevTools listening 都打出来了」。加上这行，行为与其余
// 113 条走 electron.launch 的 spec 一致（Playwright 对 Chromium 系家族测试
// 默认也是不摸真钥匙串）。
// 不变量：任何失败路径都必须有人持有并回收子进程句柄，否则孤儿实例会活进 retry。
// 之前 spawn 与「等端口」缝在同一个 async 函数里：30s deadline 或 exit 一旦
// reject，调用方的 `const launched = await launchPackaged(...)` 整句抛出，
// child 从未被赋值给外层变量，finally 里的 kill 无从谈起。现在 spawn 同步返回，
// 调用方拿到 child 之后才 await 端口 promise —— 端口等待失败时外层 child 早已
// 持有句柄，finally 照常回收。
function launchPackaged(exe: string, home: string, userDataDir: string): { child: ChildProcess; portPromise: Promise<number> } {
  const child = spawn(exe, ['--remote-debugging-port=0', `--user-data-dir=${userDataDir}`, '--use-mock-keychain'], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      KYDOG_E2E: '1', // 更新服务装配为 no-op（pickAssembly：打包 + e2e 无 fixture），不打生产 feed
      KYDOG_LOG: 'warn',
    },
  });
  let stderrBuf = '';
  const portPromise = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`打包应用 30s 内未打出 DevTools listening。stderr 累积：\n${stderrBuf}`));
    }, 30_000);
    child.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += String(chunk);
      const m = stderrBuf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`打包应用启动即退出（code=${code}）。stderr：\n${stderrBuf}`));
    });
  });
  return { child, portPromise };
}

// CDP 连上时页面可能尚未创建，poll 到第一个页面出现为止。
async function firstPage(browser: Browser): Promise<Page> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const page = browser.contexts().flatMap((c) => c.pages())[0];
    if (page) return page;
    if (Date.now() > deadline) throw new Error('CDP 已连上但 15s 内没有页面出现');
    await new Promise((r) => setTimeout(r, 250));
  }
}

test('54-packaged-smoke: 打包成品能启动、资源齐全、投影成功、内置二进制可执行', async () => {
  const built = builtPaths();
  const builtExe = path.join(built.appDir, built.exeRel);
  expect(existsSync(builtExe), `打包成品不存在：${builtExe}\n先跑 npm run package（或 npm run make）`).toBe(true);

  const appDir = await stageOutsideRepo(built.appDir);
  const exe = path.join(appDir, built.exeRel);
  const resources = path.join(appDir, built.resourcesRel);

  // —— 断言 2：资源布局静态检查（防整目录漏包）——
  // cli.json 声明的全部二进制都被 extraResource 铺到 resources 根；skills 整目录同理。
  const cliManifest = JSON.parse(
    await fs.readFile(path.join(repoRoot, 'scripts', 'cli.json'), 'utf8'),
  ) as { tools: Record<string, { binaryName: string }> };
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  for (const [tool, cfg] of Object.entries(cliManifest.tools)) {
    const bin = path.join(resources, cfg.binaryName + exeSuffix);
    expect(existsSync(bin), `packaged resources 缺 ${tool} 的二进制：${bin}`).toBe(true);
  }
  const builtinSkill = path.join(resources, 'skills', 'fact-check', 'SKILL.md');
  expect(existsSync(builtinSkill), `packaged resources 缺内置 skill：${builtinSkill}`).toBe(true);

  // —— 断言 2b：产物里剩下的 bare specifier 都能在包内解析到 ——
  // 断言 1 只覆盖启动路径上被 await 到的那一个（ProviderRegistry.build()）；懒加载的
  // external（比如某个只在用户打开 .docx 时才 import 的包）漏掉了，启动照样绿，
  // 要等用户点到那一步才炸。这里直接读产物里真实残留的裸名，逐个对照包内的
  // node_modules —— 判据来自 bundle 本身，不来自 vite.main.config.ts 的意图声明。
  const asar = readAsar(path.join(resources, 'app.asar'));
  const specs = new Set<string>();
  for (const js of asar.list('.vite/build')) {
    if (!js.endsWith('.js')) continue;
    for (const s of thirdPartySpecifiers(asar.read(js) ?? '')) specs.add(s);
  }
  expect(specs.size, '产物里一个 external 都不剩，说明这条断言的取样口失效了').toBeGreaterThan(0);
  for (const spec of specs) {
    expect(
      asar.has(`node_modules/${spec}/package.json`),
      `打包成品缺 external 模块 ${spec}：运行时 import 会 ERR_MODULE_NOT_FOUND。` +
        `把它加进 forge.config.ts 的 EXTERNAL_RUNTIME_MODULES`,
    ).toBe(true);
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-smoke-home-'));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-smoke-userdata-'));
  // onboarding 已完成态 → main.ts 启动流程会跑 skill 同步。以 en 起：启动那一次投影（phase:'startup'，
  // 不经过任何切换）要按 settings 的语言挑源 —— 「settings 说 en、磁盘是中文」正是它要挡住的不一致。
  await seedSettings(home, { locale: 'en' });

  let child: ChildProcess | null = null;
  let browser: Browser | null = null;
  try {
    const launched = launchPackaged(exe, home, userDataDir);
    child = launched.child; // 先持有句柄，再等端口——端口等待失败也回收得到
    const port = await launched.portPromise;
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await firstPage(browser);

    // —— 断言 1：启动渲染（fuses / asar / loadFile 生产分支）——
    await expect(page.locator('[data-pane="workspace"]')).toBeVisible();
    await expect(page.locator('[data-pane="main"]')).toBeVisible();
    await expect(page.locator('[data-pane="inspector"]')).toBeVisible();

    // —— 断言 3：资源解析行为检查 ——
    // 启动同步把内置 skill 从 process.resourcesPath/skills 投影到 ~/.kydog/skills。
    // 这是「应用真的读到了打包资源」的协议层落盘事实；skillSyncStateHolder 把失败
    // 收进 health 不阻断启动，所以三栏可见不能替代这条。
    // 逐字节等于成品里的英文源：既证明读到了打包资源，也证明启动投影挑的是 en 这一格
    // （落盘树只有单语言文件，SKILL.md 的内容就是源侧的 SKILL.en.md）。播种是异步的，轮询到位。
    const landed = path.join(home, '.kydog', 'skills', 'fact-check', 'SKILL.md');
    const enSource = await fs.readFile(path.join(resources, 'skills', 'fact-check', 'SKILL.en.md'), 'utf8');
    await expect
      .poll(() => fs.readFile(landed, 'utf8').catch(() => ''), { timeout: 15_000 })
      .toBe(enSource);

    // —— 断言 5：打包后的图片资源在 file:// 下真能解码（原 40-sponsor）——
    // 只断言可见没有意义：资源路径解析不到时 <img> 照样可见、只是裂图；naturalWidth 非 0 才算数。
    await page.getByTestId('user-menu-trigger').click();
    await page.getByTestId('menu-donate').click();
    const qr = page.getByTestId('sponsor-qr');
    await expect(qr).toBeVisible();
    await expect.poll(() => qr.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  } finally {
    await browser?.close().catch(() => {});
    if (child && !child.killed) {
      const exited = new Promise<void>((resolve) => child!.once('exit', () => resolve()));
      child.kill();
      // 5s 内不退再补一刀，别让僵尸进程占住 CI runner。
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }

  // —— 断言 4：内置二进制可执行（它平时只进 PATH、启动不碰，唯有真执行才知道打包后能不能跑）——
  const fastpaper = path.join(resources, 'fastpaper' + exeSuffix);
  const { stdout } = await execFileP(fastpaper, ['--version'], { timeout: 15_000 });
  expect(stdout.trim().length, `fastpaper --version 输出为空`).toBeGreaterThan(0);
});
