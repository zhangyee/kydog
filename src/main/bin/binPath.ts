import path from 'node:path';
import { app } from 'electron';

export interface BinPathInputs {
  isPackaged: boolean;
  repoRoot: string;
  resourcesPath: string;
}

export function resolveBinDir(i: BinPathInputs): string {
  return i.isPackaged
    ? i.resourcesPath
    : path.join(i.repoRoot, 'vendor', 'current');
}

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
