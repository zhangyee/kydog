import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { downloadToFile } from './urlFetch';

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'fetch-'));
}

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler).listen(0, '127.0.0.1', () => {
      const a = srv.address();
      if (typeof a === 'string' || !a) throw new Error('bad addr');
      resolve({ url: `http://127.0.0.1:${a.port}`, close: () => srv.close() });
    });
  });
}

describe('downloadToFile', () => {
  it('happy path writes bytes to dest', async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': '3' });
      res.end('abc');
    });
    try {
      const dest = path.join(tmp(), 'out.bin');
      await downloadToFile(url + '/x', dest, { maxBytes: 100, timeoutMs: 1000, allowHttp: true });
      const buf = readFileSync(dest);
      expect(buf.toString()).toBe('abc');
    } finally {
      close();
    }
  });

  it('throws skill.too_large on Content-Length over cap', async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Length': '999' });
      res.end('xxx');
    });
    try {
      const dest = path.join(tmp(), 'out.bin');
      await expect(
        downloadToFile(url + '/x', dest, { maxBytes: 10, timeoutMs: 1000, allowHttp: true }),
      ).rejects.toThrow(/超过上限/);
    } finally {
      close();
    }
  });

  it('throws skill.too_large on streamed bytes exceeding cap', async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200); // no Content-Length
      res.write('a'.repeat(100));
      res.end();
    });
    try {
      const dest = path.join(tmp(), 'out.bin');
      await expect(
        downloadToFile(url + '/x', dest, { maxBytes: 10, timeoutMs: 1000, allowHttp: true }),
      ).rejects.toThrow(/超过上限/);
    } finally {
      close();
    }
  });

  it('throws skill.network on non-2xx', async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    try {
      const dest = path.join(tmp(), 'out.bin');
      await expect(
        downloadToFile(url + '/x', dest, { maxBytes: 100, timeoutMs: 1000, allowHttp: true }),
      ).rejects.toThrow(/下载失败/);
    } finally {
      close();
    }
  });

  it('throws skill.network on timeout', async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200);
      // never end within the timeout
      setTimeout(() => res.end(), 5000);
    });
    try {
      const dest = path.join(tmp(), 'out.bin');
      await expect(
        downloadToFile(url + '/x', dest, { maxBytes: 100, timeoutMs: 200, allowHttp: true }),
      ).rejects.toThrow(/下载超时/);
    } finally {
      close();
    }
  }, 8000);
});
