import path from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const cliManifest = JSON.parse(
  readFileSync(path.join(__dirname, 'scripts', 'cli.json'), 'utf-8')
) as { tools: Record<string, { binaryName: string }> };
const isWindows = process.platform === 'win32';
const vendorBins = Object.values(cliManifest.tools).map((cfg) =>
  path.join('vendor', 'current', cfg.binaryName + (isWindows ? '.exe' : ''))
);

// —— 打包成品要自带的运行时模块闭包 ——
//
// 主进程 bundle 里唯一没被 vite 打进去的第三方 bare specifier 是
// @earendil-works/pi-coding-agent（vite.main.config.ts 的 external）。而
// @electron-forge/plugin-vite 默认装的 packagerConfig.ignore 只放行 /.vite，
// node_modules 一个文件都不进包 —— 装到 %LOCALAPPDATA% / /Applications 的成品里
// `import('@earendil-works/pi-coding-agent')` 直接 ERR_MODULE_NOT_FOUND，而
// ProviderRegistry.build() 就排在 main.ts 的启动 await 链上，应用开机即死。
//
// 开发机上看不出来：out/ 就在仓库里，Node 解析 bare specifier 时逐级上溯父目录，
// 正好摸到 <repo>/node_modules —— 借的是开发树的货。e2e/54 因此把打包成品复制到
// 仓库外再启动，把这条逃生路径掐掉。
//
// 这里按 package.json 的依赖边算出闭包，只放行闭包内的目录：renderer 侧那些 vite
// 早已 bundle 进去的依赖（@fontsource / pdfjs-dist / canvas …，生产依赖全集 400+ MB）
// 照旧挡在包外。
const EXTERNAL_RUNTIME_MODULES = ['@earendil-works/pi-coding-agent', 'undici'];

function resolveModuleDir(name: string, from: string): string | null {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// 返回闭包内每个模块的绝对目录。dependencies 解析不到就抛：漏一个包等于成品少一块，
// 而少的那块只有装到别的机器上才看得见——这种失败必须留在构建期。
// optionalDependencies 解析不到是它的正常语义（平台不匹配等），跳过。
function runtimeModuleClosure(entries: readonly string[]): string[] {
  const dirs = new Set<string>();
  const visit = (name: string, from: string): boolean => {
    const dir = resolveModuleDir(name, from);
    if (dir === null) return false;
    if (dirs.has(dir)) return true;
    dirs.add(dir);
    const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    for (const dep of Object.keys(pj.dependencies ?? {})) {
      if (!visit(dep, dir)) {
        throw new Error(`打包依赖闭包缺失：${name} 的依赖 ${dep} 在 node_modules 里找不到；先跑 npm install`);
      }
    }
    for (const dep of Object.keys(pj.optionalDependencies ?? {})) visit(dep, dir);
    return true;
  };
  for (const entry of entries) {
    if (!visit(entry, __dirname)) {
      throw new Error(`打包依赖闭包缺失：external 模块 ${entry} 在 node_modules 里找不到；先跑 npm install`);
    }
  }
  return [...dirs];
}

// packager 交给 ignore 的是「以 / 开头、相对项目根、posix 分隔」的路径
// （@electron/packager copy-filter.ts 里 normalizePath 之后那一步）。
const runtimeModulePrefixes = runtimeModuleClosure(EXTERNAL_RUNTIME_MODULES).map((dir) => {
  const rel = path.relative(__dirname, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`打包依赖闭包越出项目根，进不了包：${dir}`);
  }
  return '/' + rel.split(path.sep).join('/');
});

function keepInPackage(file: string): boolean {
  // vite 的产物：主进程 / preload / renderer 三份 bundle
  if (file === '/.vite' || file.startsWith('/.vite/')) return true;
  for (const prefix of runtimeModulePrefixes) {
    if (file === prefix || file.startsWith(prefix + '/')) return true; // 闭包内的文件
    if (prefix.startsWith(file + '/')) return true;                    // 通往闭包的祖先目录
  }
  return false;
}

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // 白名单式 ignore，覆盖 plugin-vite 默认那份「只留 /.vite」：/.vite + 上面算出的
    // 运行时模块闭包。设成函数后 @electron/packager 不再叠加它的 DEFAULT_IGNORES
    // （.git / lockfile / node_modules/.bin），而白名单本来就把它们挡在外面。
    ignore: (file) => (file ? !keepInPackage(file) : false),
    // prune 会绕过 ignore 自行裁决「模块根目录」的去留（copy-filter.ts：isModule 命中
    // 就交给 Pruner），生产依赖的根目录会被它一路放行，包里只剩一地空目录。白名单已经
    // 是精确闭包，关掉 prune，让这份名单成为唯一裁判。
    prune: false,
    icon: path.join(__dirname, 'assets/icons/icon'), // forge 按平台自动追加 .icns / .ico
    extraResource: [...vendorBins, 'src/skills'],
    // 等加 Developer ID 时：osxSign / osxNotarize / windowsSign。在那之前由下面的
    // postPackage 钩子做 adhoc 整包重签（只消 Gatekeeper 的 Fatal，消不掉「未验证开发者」）。
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({}),
    // zip 必须保留：更新服务靠 .*-(mac|darwin|osx).*\.zip 匹配 darwin 资产，
    // 没有它 macOS 的 feed 直接 404。dmg 只给人手动安装用，服务会忽略它。
    new MakerZIP({}, ['darwin']),
    // 不设 name：maker-dmg 默认把产物重命名为 KyDog-<version>-<targetArch>.dmg
    // （MakerDMG.js 里 forgeDefaultOutPath），版本、架构都齐——arm64 与 x64 是两个
    // 独立 CI job，产物 merge-multiple 汇到同一目录，靠 targetArch 后缀防互相覆盖。
    // 别再手工设 name：那会覆盖掉这个默认名（曾产出过缺版本号的 KyDog-arm64.dmg），
    // 且 process.arch 是构建机架构，不如 Forge 传入的 targetArch 准确。
    new MakerDMG({}, ['darwin']),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        { entry: 'src/main/main.ts', config: 'vite.main.config.ts', target: 'main' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts', target: 'preload' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.mts' }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      strictlyRequireAllFuses: true,
      [FuseV1Options.RunAsNode]: false,
      // 关着：开了它 Chromium 会把 cookie 库加密落盘，密钥放 macOS 钥匙串（条目 "KyDog Safe Storage"）。
      // 钥匙串的访问控制绑在代码签名上，而下面的 postPackage 每次打包都重签一次 adhoc、cdhash 每次不同，
      // 于是每个新成品第一次启动都弹一次「KyDog 想使用钥匙串中的机密信息」，要输登录密码。
      //
      // 现在护的是空的：登录走 shell.openExternal 交给系统浏览器（src/main/llm/oauth.ts），应用内没有网页
      // 会话，全仓库不碰 session / cookies API；BYOK 密钥在 ~/.kydog 下 0600 的文件里，与这把钥匙无关。
      //
      // **做应用内浏览（in-app browsing）时改回 true**：那时会话 cookie 才真的存东西，明文躺在
      // ~/Library/Application Support/KyDog/ 里就不合适了。届时同期该有 Developer ID 证书，签名身份稳定，
      // 钥匙串也就不会每次打包都重问。
      [FuseV1Options.EnableCookieEncryption]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      // EmbeddedAsarIntegrityValidation + OnlyLoadAppFromAsar both require macOS
      // code signing to function correctly. On unsigned dev builds they cause
      // ERR_FILE_NOT_FOUND when loading any asar-internal resource. Re-enable
      // both when notarization lands (B').
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: false,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      // Packaged renderer is loaded via `mainWindow.loadFile(...)`, so keep
      // the file protocol privileges that Electron expects for `file://`.
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
      [FuseV1Options.WasmTrapHandlers]: false,
    }),
  ],
  hooks: {
    // macOS 成品必须在这里整包重签一次 adhoc，否则从浏览器下载的成品（带
    // com.apple.quarantine）会被 Gatekeeper 判成「已损坏，应移到废纸篓」。
    //
    // 成因是签名与改动的先后：Electron 预置二进制自带一份 adhoc 签名，而
    // @electron/packager 在拷完文件之后还要改 Info.plist（写应用名与版本）、铺
    // extraResource —— 封印随即作废。FusesPlugin 的 resetAdHocDarwinSignature 补不上
    // 这一刀：它只重签「Electron 可执行文件」那一个 Mach-O，且发生在 packageAfterCopy，
    // 早于 Info.plist 改写（FusesPlugin.js:20 与 :36）。2026-09-02 的 v0.2.0 就是这么发出去的，
    // syspolicy_check 的原话：Invalid Info.plist (plist or signature have been modified)，
    // Severity: Fatal，Suggested Fix: Resign the application using the codesign command。
    //
    // postPackage 是全部文件落盘之后的第一个时机，重签放这里才盖得住所有改动。
    // 消掉的只是那条 Fatal；剩下的「adhoc signed，不适合分发」要 Developer ID + 公证，
    // 是另一档（届时改配 osxSign/osxNotarize，这个钩子就该让位）。
    postPackage: async (_forgeConfig, result) => {
      if (result.platform !== 'darwin') return;
      for (const out of result.outputPaths) {
        const apps = readdirSync(out).filter((f) => f.endsWith('.app'));
        // 不从 productName 拼路径：产物名由 packager 决定，拼错会静默跳过重签，
        // 而漏签只在用户下载后才看得见。这里认产物本身，数量不是 1 就直接红。
        if (apps.length !== 1) throw new Error(`postPackage 期望 ${out} 下恰好一个 .app，实得 ${apps.length} 个`);
        const app = path.join(out, apps[0]);
        execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
        // 签完立刻验：签名坏在构建期是可修的，坏在用户机器上只剩「已损坏」四个字。
        execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
      }
    },
  },
};

export default config;
