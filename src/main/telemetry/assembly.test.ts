import { describe, it, expect } from 'vitest';
import { telemetryAllowed } from './assembly';

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
