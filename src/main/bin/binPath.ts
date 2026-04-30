import path from 'node:path';
import { app } from 'electron';

export interface BinPathInputs {
  isPackaged: boolean;
  repoRoot: string;          // dev mode only; ignored in packaged
  resourcesPath: string;     // process.resourcesPath
}

export interface FastpaperPathInputs extends BinPathInputs {
  platform: typeof process.platform;
}

export function resolveBinDir(i: BinPathInputs): string {
  return i.isPackaged
    ? i.resourcesPath
    : path.join(i.repoRoot, 'vendor', 'current');
}

export function resolveFastpaperPath(i: FastpaperPathInputs): string {
  const exe = i.platform === 'win32' ? 'fastpaper.exe' : 'fastpaper';
  return path.join(resolveBinDir(i), exe);
}

// Live wrapper used by main process. In dev mode, main.js is built to .vite/build/main.js
// (by vite). repoRoot needs to climb two levels from there.
function liveRepoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

export function binDir(): string {
  return resolveBinDir({
    isPackaged: app.isPackaged,
    repoRoot: liveRepoRoot(),
    resourcesPath: process.resourcesPath,
  });
}

export function fastpaperPath(): string {
  return resolveFastpaperPath({
    isPackaged: app.isPackaged,
    repoRoot: liveRepoRoot(),
    resourcesPath: process.resourcesPath,
    platform: process.platform,
  });
}
