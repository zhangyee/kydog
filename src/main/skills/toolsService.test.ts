// POSIX-only test fixtures (`#!/bin/sh` scripts). Project does not run main-process
// vitest on Windows in CI, so the timeout test does not need a Windows variant.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolsService } from './toolsService';

function tmp() {
  return mkdtempSync(path.join(tmpdir(), 'tools-'));
}

describe('ToolsService.list', () => {
  it('lists executables and their --version', async () => {
    const dir = tmp();
    const fp = path.join(dir, 'fastpaper');
    writeFileSync(fp, '#!/bin/sh\necho 1.4.0\n');
    chmodSync(fp, 0o755);
    const svc = new ToolsService({ binDir: () => dir, ttlMs: 1000 });
    const list = await svc.list();
    expect(list[0].name).toBe('fastpaper');
    expect(list[0].version).toBe('1.4.0');
    expect(list[0].path).toBe(fp);
  });

  it('handles --version timeout → version=null', async () => {
    const dir = tmp();
    const fp = path.join(dir, 'slow');
    writeFileSync(fp, '#!/bin/sh\nsleep 5\n');
    chmodSync(fp, 0o755);
    const svc = new ToolsService({ binDir: () => dir, ttlMs: 1000, spawnTimeoutMs: 200 });
    const list = await svc.list();
    expect(list[0].version).toBe(null);
  }, 10000);

  it('caches under TTL, refetches on force', async () => {
    const dir = tmp();
    const fp = path.join(dir, 'tool');
    writeFileSync(fp, '#!/bin/sh\necho 1\n');
    chmodSync(fp, 0o755);
    const svc = new ToolsService({ binDir: () => dir, ttlMs: 1_000_000 });
    const a = await svc.list();
    writeFileSync(fp, '#!/bin/sh\necho 2\n');
    const b = await svc.list();
    expect(b[0].version).toBe(a[0].version);
    const c = await svc.list({ force: true });
    expect(c[0].version).toBe('2');
  });
});
