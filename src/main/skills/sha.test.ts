import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256OfFile, sha256OfBuffer } from './sha';

describe('sha256', () => {
  it('hashes "hello"', () => {
    expect(sha256OfBuffer(Buffer.from('hello'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });
  it('hashes a file', () => {
    const d = mkdtempSync(path.join(tmpdir(), 'sha-'));
    const f = path.join(d, 'x.txt');
    writeFileSync(f, 'hello');
    expect(sha256OfFile(f)).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    );
  });
});
