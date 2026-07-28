import { describe, it, expect } from 'vitest';
import { mapPlatformArch, binaryFileName } from './targets.mjs';

describe('targets', () => {
  it('mapPlatformArch darwin-arm64', () => {
    expect(mapPlatformArch('darwin', 'arm64')).toBe('darwin-arm64');
  });
  it('mapPlatformArch darwin-x64', () => {
    expect(mapPlatformArch('darwin', 'x64')).toBe('darwin-x64');
  });
  it('mapPlatformArch win32-x64', () => {
    expect(mapPlatformArch('win32', 'x64')).toBe('win32-x64');
  });
  it('mapPlatformArch throws on linux', () => {
    expect(() => mapPlatformArch('linux', 'x64')).toThrow(/unsupported platform/i);
  });
  it('binaryFileName adds .exe on win32', () => {
    expect(binaryFileName('fastpaper', 'win32')).toBe('fastpaper.exe');
  });
  it('binaryFileName no suffix on darwin', () => {
    expect(binaryFileName('fastpaper', 'darwin')).toBe('fastpaper');
  });
});
