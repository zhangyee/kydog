import path from 'node:path';
import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const fastpaperRel = process.platform === 'win32'
  ? path.join('vendor', 'current', 'fastpaper.exe')
  : path.join('vendor', 'current', 'fastpaper');

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: path.join(__dirname, 'assets/icons/icon'), // forge 按平台自动追加 .icns / .ico
    extraResource: [fastpaperRel, 'src/skills'],
    // 等加签名时：osxSign / osxNotarize / windowsSign
  },
  rebuildConfig: {},
  makers: [new MakerSquirrel({}), new MakerZIP({}, ['darwin'])],
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
