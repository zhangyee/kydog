import { describe, it, expect } from 'vitest';
import path from 'node:path';

// We can't easily mock electron's `app.isPackaged` and `process.resourcesPath` from outside,
// so binPath.ts exposes a pure resolver that takes them as inputs. The thin Electron wrapper
// reads them at call-time.
import { resolveBinDir } from './binPath';

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
