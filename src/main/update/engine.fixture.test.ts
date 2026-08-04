import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFixtureEngine, createNoopEngine } from './engine';

function tmpFixture(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kydog-fixture-'));
  const file = path.join(dir, 'f.json');
  writeFileSync(file, content, 'utf8');
  return file;
}

const signal = () => new AbortController().signal;

describe('fixture CheckEngine', () => {
  it('读得到就原样返回 fixture 里的 outcome', async () => {
    const file = tmpFixture(JSON.stringify({ kind: 'available', candidateId: 'https://gh/x.zip', label: 'KyDog 0.2.0' }));
    const e = createFixtureEngine(file);
    expect(await e.run(signal())).toEqual({ kind: 'available', candidateId: 'https://gh/x.zip', label: 'KyDog 0.2.0' });
  });

  it('文件不存在 → failed，不 reject（与真实引擎同契约）', async () => {
    const e = createFixtureEngine(path.join(tmpdir(), 'kydog-does-not-exist', 'f.json'));
    const r = await e.run(signal());
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.retry).toBe('allowed');
  });

  it('JSON 损坏 → failed，不 reject', async () => {
    const file = tmpFixture('{ not json');
    const e = createFixtureEngine(file);
    const r = await e.run(signal());
    expect(r.kind).toBe('failed');
    if (r.kind === 'failed') expect(r.retry).toBe('allowed');
  });

  it('每次 run 都重读文件，e2e 才能中途改写 fixture 驱动状态迁移', async () => {
    const file = tmpFixture(JSON.stringify({ kind: 'none' }));
    const e = createFixtureEngine(file);
    expect(await e.run(signal())).toEqual({ kind: 'none' });
    writeFileSync(file, JSON.stringify({ kind: 'downloaded', label: 'KyDog 0.2.0' }), 'utf8');
    expect(await e.run(signal())).toEqual({ kind: 'downloaded', label: 'KyDog 0.2.0' });
    rmSync(path.dirname(file), { recursive: true, force: true });
  });
});

describe('no-op CheckEngine', () => {
  it('永远 none：开发态与 e2e 都不该打真实 feed', async () => {
    expect(await createNoopEngine().run(signal())).toEqual({ kind: 'none' });
  });

  it('不支持安装，调用即抛', () => {
    expect(() => createNoopEngine().quitAndInstall()).toThrow();
  });
});
