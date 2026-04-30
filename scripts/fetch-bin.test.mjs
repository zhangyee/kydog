// scripts/fetch-bin.test.mjs
import { describe, it, expect } from 'vitest';
import { mapPlatformArch, assetForTarget, urlFor } from './fetch-bin.mjs';

describe('fetch-bin pure helpers', () => {
  it('maps darwin-arm64 to aarch64-apple-darwin', () => {
    expect(mapPlatformArch('darwin', 'arm64')).toBe('darwin-arm64');
  });
  it('maps darwin-x64 to darwin-x64', () => {
    expect(mapPlatformArch('darwin', 'x64')).toBe('darwin-x64');
  });
  it('maps win32-x64', () => {
    expect(mapPlatformArch('win32', 'x64')).toBe('win32-x64');
  });
  it('throws on unsupported (linux)', () => {
    expect(() => mapPlatformArch('linux', 'x64')).toThrow(/unsupported platform/i);
  });
  it('asset on win32 is .zip, otherwise .tar.xz', () => {
    expect(assetForTarget('win32-x64')).toMatch(/\.zip$/);
    expect(assetForTarget('darwin-arm64')).toMatch(/\.tar\.xz$/);
  });
  it('urlFor substitutes version + asset', () => {
    const url = urlFor({
      template: 'https://example.com/v{version}/{asset}',
      version: '0.1.0',
      asset: 'foo.zip',
    });
    expect(url).toBe('https://example.com/v0.1.0/foo.zip');
  });
});
