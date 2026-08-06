import { describe, it, expect } from 'vitest';
import { telemetryAllowed, exactPlatform, exactArch, versionOk } from './gate';
import { MAX_VERSION_LEN } from '../../shared/telemetryContract';

describe('telemetryAllowed', () => {
  it('打包且非 e2e 时放行', () => {
    expect(telemetryAllowed({ isPackaged: true, e2e: undefined })).toBe(true);
  });

  it('未打包（npm start）一律拦下', () => {
    expect(telemetryAllowed({ isPackaged: false, e2e: undefined })).toBe(false);
  });

  it('e2e 一律拦下，即使已打包', () => {
    expect(telemetryAllowed({ isPackaged: true, e2e: '1' })).toBe(false);
  });
});

describe('exactPlatform', () => {
  it('契约枚举内的值原样返回', () => {
    expect(exactPlatform('darwin')).toBe('darwin');
    expect(exactPlatform('win32')).toBe('win32');
  });

  it('枚举外的值返回 null，绝不映射成某个枚举值', () => {
    // linux 必须是 null 而不是 darwin：映射等于拿编造的值顶替事实
    expect(exactPlatform('linux')).toBe(null);
    expect(exactPlatform('freebsd')).toBe(null);
    expect(exactPlatform('')).toBe(null);
    expect(exactPlatform('x64')).toBe(null); // 串了架构枚举也不认
  });
});

describe('exactArch', () => {
  it('契约枚举内的值原样返回', () => {
    expect(exactArch('x64')).toBe('x64');
    expect(exactArch('arm64')).toBe('arm64');
  });

  it('枚举外的值返回 null，绝不映射成某个枚举值', () => {
    expect(exactArch('ia32')).toBe(null);
    expect(exactArch('arm')).toBe(null);
    expect(exactArch('')).toBe(null);
    expect(exactArch('darwin')).toBe(null);
  });
});

describe('versionOk', () => {
  it('合法 semver 通过', () => {
    expect(versionOk('0.1.0')).toBe(true);
    expect(versionOk('1.2.3')).toBe(true);
    expect(versionOk('1.2.3-beta.1')).toBe(true);
    expect(versionOk('1.2.3+build.7')).toBe(true);
  });

  it('非 semver 不通过', () => {
    expect(versionOk('1.2')).toBe(false);
    expect(versionOk('v1.2.3')).toBe(false);
    expect(versionOk('')).toBe(false);
    expect(versionOk('unknown')).toBe(false);
  });

  it('超长不通过，即使形状是合法 semver', () => {
    const long = `1.2.3-${'a'.repeat(MAX_VERSION_LEN)}`;
    expect(long.length).toBeGreaterThan(MAX_VERSION_LEN);
    expect(versionOk(long)).toBe(false);
    // 边界：恰好 MAX_VERSION_LEN 仍然通过
    const exact = `1.2.3-${'a'.repeat(MAX_VERSION_LEN - 6)}`;
    expect(exact.length).toBe(MAX_VERSION_LEN);
    expect(versionOk(exact)).toBe(true);
  });
});
