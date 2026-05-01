import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getVertexAuthStatus } from './vertexStatus';

describe('getVertexAuthStatus', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-vertex-'));
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  it('cfg 缺 project/location → unconfigured', async () => {
    expect((await getVertexAuthStatus(undefined)).configured).toBe(false);
    expect((await getVertexAuthStatus({ kind: 'vertex', project: '', location: '' })).configured).toBe(false);
    expect((await getVertexAuthStatus({ kind: 'vertex', project: 'p', location: '' })).configured).toBe(false);
  });

  it('serviceAccountKeyPath 文件存在 → configured + label', async () => {
    const sa = path.join(dir, 'sa.json');
    writeFileSync(sa, '{}');
    const r = await getVertexAuthStatus({ kind: 'vertex', project: 'p', location: 'l', serviceAccountKeyPath: sa });
    expect(r.configured).toBe(true);
    expect(r.source).toBe('stored');
    expect(r.label).toContain('sa.json');
  });

  it('serviceAccountKeyPath 文件不存在 → unconfigured + 提示', async () => {
    const r = await getVertexAuthStatus({ kind: 'vertex', project: 'p', location: 'l', serviceAccountKeyPath: '/nope.json' });
    expect(r.configured).toBe(false);
    expect(r.label).toContain('文件不存在');
  });

  it('GOOGLE_APPLICATION_CREDENTIALS env 优先 → ADC label', async () => {
    const adc = path.join(dir, 'adc.json');
    writeFileSync(adc, '{}');
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', adc);
    const r = await getVertexAuthStatus({ kind: 'vertex', project: 'p', location: 'l' });
    expect(r.configured).toBe(true);
    expect(r.label).toBe('ADC');
  });

  it('默认 ADC 路径不存在 → 提示运行 gcloud', async () => {
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '');
    const r = await getVertexAuthStatus({ kind: 'vertex', project: 'p', location: 'l' });
    if (!r.configured) {
      expect(r.label).toContain('gcloud auth application-default login');
    }
  });
});
