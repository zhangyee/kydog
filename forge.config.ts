import path from 'node:path';
import { readFileSync } from 'node:fs';
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

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: path.join(__dirname, 'assets/icons/icon'), // forge 按平台自动追加 .icns / .ico
    extraResource: [...vendorBins, 'src/skills'],
    // 等加签名时：osxSign / osxNotarize / windowsSign
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
      [FuseV1Options.EnableCookieEncryption]: true,
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
};

export default config;
