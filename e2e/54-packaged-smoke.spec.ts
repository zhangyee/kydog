import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { seedSettings } from './helpers';

const execFileP = promisify(execFile);
const repoRoot = path.resolve(__dirname, '..');

// 这是 infra 预算（冷 CI 首启 + 打包应用），不是行为判据；expect.timeout 的 5s
// 紧判据不受影响。内部预算加总（30s 启动 + 15s 首页 + 3×5s 三栏断言 + 15s 投影
// poll + 5s 收尾 + 15s fastpaper）逼近 playwright.config.ts 的全局 60s，冷 CI
// （如 windows-latest 首次 Defender 扫描）撞上限是基础设施抖动，不是产品判据。
test.setTimeout(120_000);

// 打包成品的落点（electron-forge package / make 的输出布局）。
// 二进制缺失时直接红、报错指路——不做 skipIf：静默跳过会让「打包成品层」的覆盖
// 在流水线上无声消失，与 KYDOG_REQUIRE_SYMLINK 的教训同型。
function packagedPaths(): { exe: string; resources: string } {
  if (process.platform === 'darwin') {
    const appDir = path.join(repoRoot, 'out', `KyDog-darwin-${process.arch}`);
    return {
      exe: path.join(appDir, 'KyDog.app', 'Contents', 'MacOS', 'KyDog'),
      resources: path.join(appDir, 'KyDog.app', 'Contents', 'Resources'),
    };
  }
  const appDir = path.join(repoRoot, 'out', 'KyDog-win32-x64');
  return {
    exe: path.join(appDir, 'KyDog.exe'),
    resources: path.join(appDir, 'resources'),
  };
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
  const { exe, resources } = packagedPaths();
  expect(existsSync(exe), `打包成品不存在：${exe}\n先跑 npm run package（或 npm run make）`).toBe(true);

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

  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-smoke-home-'));
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-smoke-userdata-'));
  await seedSettings(home); // onboarding 已完成态 → main.ts 启动流程会跑 skill 同步

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
    await expect
      .poll(async () => existsSync(path.join(home, '.kydog', 'skills', 'fact-check', 'SKILL.md')), {
        timeout: 15_000,
      })
      .toBe(true);
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
