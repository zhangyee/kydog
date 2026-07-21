// src/main/log.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { redactSecrets, createLogSink } from './log';

describe('redactSecrets', () => {
  it('redacts apiKey at any nesting', () => {
    const input = { provider: { apiKey: 'sk-abc', model: 'x' } };
    expect(redactSecrets(input)).toEqual({ provider: { apiKey: '[REDACTED]', model: 'x' } });
  });
  it('redacts Authorization header', () => {
    expect(redactSecrets({ headers: { Authorization: 'Bearer xx' } })).toEqual({
      headers: { Authorization: '[REDACTED]' },
    });
  });
  it('handles arrays', () => {
    expect(redactSecrets([{ apiKey: 'a' }])).toEqual([{ apiKey: '[REDACTED]' }]);
  });
  it('returns primitives unchanged', () => {
    expect(redactSecrets('hello')).toBe('hello');
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBe(null);
  });
  it('redacts when secret value is itself an object', () => {
    expect(redactSecrets({ apiKey: { primary: 'sk-x', backup: 'sk-y' } })).toEqual({
      apiKey: '[REDACTED]',
    });
  });
  it('short-circuits Uint8Array to [Bytes]', () => {
    expect(redactSecrets(new Uint8Array([1, 2, 3]))).toBe('[Bytes]');
  });
  it('handles circular references without throwing', () => {
    const a: any = { x: 1 };
    a.self = a;
    expect(() => redactSecrets(a)).not.toThrow();
    const result = redactSecrets(a) as Record<string, unknown>;
    expect(result['x']).toBe(1);
    expect(result['self']).toBe('[Circular]');
  });
  it('redacts newly-broadened secret keys: token, cookie, secret', () => {
    expect(redactSecrets({ token: 't', cookie: 'c', secret: 's', safe: 'ok' })).toEqual({
      token: '[REDACTED]',
      cookie: '[REDACTED]',
      secret: '[REDACTED]',
      safe: 'ok',
    });
  });
});

describe('createLogSink', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kydog-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('appends lines in call order', async () => {
    const file = path.join(dir, 'main.log');
    const sink = createLogSink(file, 1024);
    void sink.write('first');
    await sink.write('second');
    expect(await fs.readFile(file, 'utf8')).toBe('first\nsecond\n');
  });

  it('creates the parent directory if missing', async () => {
    const file = path.join(dir, 'nested', 'logs', 'main.log');
    const sink = createLogSink(file, 1024);
    await sink.write('hello');
    expect(await fs.readFile(file, 'utf8')).toBe('hello\n');
  });

  it('rotates to .1 once size exceeds the cap and starts fresh', async () => {
    const file = path.join(dir, 'main.log');
    const sink = createLogSink(file, 20);
    await sink.write('aaaaaaaaaa'); // 11 bytes, under cap
    await sink.write('bbbbbbbbbb'); // 22 bytes total, now over cap
    await sink.write('cccccccccc'); // triggers rotation before writing
    expect(await fs.readFile(file + '.1', 'utf8')).toBe('aaaaaaaaaa\nbbbbbbbbbb\n');
    expect(await fs.readFile(file, 'utf8')).toBe('cccccccccc\n');
  });

  it('counts a pre-existing oversized file toward the cap', async () => {
    const file = path.join(dir, 'main.log');
    await fs.writeFile(file, 'x'.repeat(30), 'utf8');
    const sink = createLogSink(file, 20);
    await sink.write('fresh');
    expect(await fs.readFile(file + '.1', 'utf8')).toBe('x'.repeat(30));
    expect(await fs.readFile(file, 'utf8')).toBe('fresh\n');
  });

  it('keeps only one generation: second rotation overwrites .1', async () => {
    const file = path.join(dir, 'main.log');
    const sink = createLogSink(file, 10);
    await sink.write('gen1-aaaaaaaa'); // over cap after write
    await sink.write('gen2-bbbbbbbb'); // rotates gen1 out, over cap again
    await sink.write('gen3');          // rotates gen2 out, overwriting .1
    expect(await fs.readFile(file + '.1', 'utf8')).toBe('gen2-bbbbbbbb\n');
    expect(await fs.readFile(file, 'utf8')).toBe('gen3\n');
  });
});
