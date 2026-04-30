import { describe, it, expect } from 'vitest';
import path from 'node:path';

// We can't easily mock electron's `app.isPackaged` and `process.resourcesPath` from outside,
// so binPath.ts exposes a pure resolver that takes them as inputs. The thin Electron wrapper
// reads them at call-time.
import { resolveBinDir, resolveFastpaperPath } from './binPath';

describe('binPath.resolveBinDir', () => {
  it('dev mode: returns <repoRoot>/vendor/current', () => {
    expect(resolveBinDir({ isPackaged: false, repoRoot: '/repo', resourcesPath: '/ignored' }))
      .toBe(path.join('/repo', 'vendor', 'current'));
  });
  it('packaged mode: returns process.resourcesPath', () => {
    expect(resolveBinDir({ isPackaged: true, repoRoot: '/ignored', resourcesPath: '/Apps/X.app/Contents/Resources' }))
      .toBe('/Apps/X.app/Contents/Resources');
  });
});

describe('binPath.resolveFastpaperPath', () => {
  it('appends fastpaper on posix', () => {
    expect(resolveFastpaperPath({ isPackaged: false, repoRoot: '/r', resourcesPath: '/x', platform: 'darwin' }))
      .toBe(path.join('/r', 'vendor', 'current', 'fastpaper'));
  });
  it('appends fastpaper.exe on win32', () => {
    expect(resolveFastpaperPath({ isPackaged: true, repoRoot: '/r', resourcesPath: 'C:/Apps/KyDog/resources', platform: 'win32' }))
      .toBe(path.join('C:/Apps/KyDog/resources', 'fastpaper.exe'));
  });
});
