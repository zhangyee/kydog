import { describe, it, expect } from 'vitest';
import { detectBashOnWindowsImpl } from './shellCheck';

describe('detectBashOnWindowsImpl', () => {
  it('found at ProgramFiles/Git/bin/bash.exe', () => {
    const r = detectBashOnWindowsImpl({
      env: { ProgramFiles: 'C:\\Program Files' },
      existsSync: (p) => p === 'C:\\Program Files\\Git\\bin\\bash.exe',
      spawnSync: () => { throw new Error('should not reach where'); },
    });
    expect(r.found).toBe(true);
    expect(r.searched).toContain('C:\\Program Files\\Git\\bin\\bash.exe');
  });
  it('falls back to where bash.exe', () => {
    const r = detectBashOnWindowsImpl({
      env: {},
      existsSync: (p) => p === 'C:\\msys64\\usr\\bin\\bash.exe',
      spawnSync: () => ({ status: 0, stdout: 'C:\\msys64\\usr\\bin\\bash.exe\r\n', stderr: '' }),
    });
    expect(r.found).toBe(true);
  });
  it('not found anywhere', () => {
    const r = detectBashOnWindowsImpl({
      env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
      existsSync: () => false,
      spawnSync: () => ({ status: 1, stdout: '', stderr: 'not found' }),
    });
    expect(r.found).toBe(false);
    expect(r.searched).toEqual([
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      'PATH (where bash.exe)',
    ]);
  });
});
