// src/main/persist/atomicWrite.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWrite } from './atomicWrite';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe('atomicWrite', () => {
  it('writes the file', async () => {
    const target = path.join(dir, 'a.json');
    await atomicWrite(target, '{"x":1}');
    expect(await fs.readFile(target, 'utf8')).toBe('{"x":1}');
  });
  it('overwrites existing content', async () => {
    const target = path.join(dir, 'a.json');
    await fs.writeFile(target, 'old');
    await atomicWrite(target, 'new');
    expect(await fs.readFile(target, 'utf8')).toBe('new');
  });
  it('does not leave .tmp files on success', async () => {
    const target = path.join(dir, 'a.json');
    await atomicWrite(target, 'x');
    const entries = await fs.readdir(dir);
    expect(entries.filter(e => e.includes('.tmp.'))).toEqual([]);
  });
});
