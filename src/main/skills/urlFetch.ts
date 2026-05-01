import { createWriteStream, promises as fsp } from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { KydogError } from '../../shared/errors';

export interface DownloadOptions {
  maxBytes: number;
  timeoutMs: number;
  /** test-only: allow http URLs (production use https only) */
  allowHttp?: boolean;
}

export async function downloadToFile(
  url: string,
  dest: string,
  opts: DownloadOptions,
): Promise<void> {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  if (!isHttps && !opts.allowHttp) {
    throw new KydogError('skill.network', '只支持 https 下载');
  }
  const lib = isHttps ? https : http;

  await new Promise<void>((resolve, reject) => {
    const ws = createWriteStream(dest);
    let received = 0;
    let settled = false;
    const settle = (fn: () => void): void => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const timer = setTimeout(() => {
      settle(() => {
        ws.destroy();
        void fsp.unlink(dest).catch(() => {});
        reject(new KydogError('skill.network', `下载超时（${opts.timeoutMs}ms）`));
      });
    }, opts.timeoutMs);

    const req = lib.get(url, (res) => {
      const status = res.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        settle(() => {
          clearTimeout(timer);
          res.resume();
          ws.destroy();
          void fsp.unlink(dest).catch(() => {});
          reject(new KydogError('skill.network', `下载失败：HTTP ${status}`));
        });
        return;
      }
      const cl = parseInt(res.headers['content-length'] ?? '', 10);
      if (Number.isFinite(cl) && cl > opts.maxBytes) {
        settle(() => {
          clearTimeout(timer);
          res.resume();
          ws.destroy();
          void fsp.unlink(dest).catch(() => {});
          reject(
            new KydogError(
              'skill.too_large',
              `archive 超过上限 ${opts.maxBytes} bytes（Content-Length=${cl}）`,
            ),
          );
        });
        return;
      }
      res.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > opts.maxBytes) {
          settle(() => {
            clearTimeout(timer);
            res.destroy();
            ws.destroy();
            void fsp.unlink(dest).catch(() => {});
            reject(
              new KydogError('skill.too_large', `archive 超过上限 ${opts.maxBytes} bytes`),
            );
          });
          return;
        }
        ws.write(chunk);
      });
      res.on('end', () => {
        settle(() => {
          clearTimeout(timer);
          ws.end(() => resolve());
        });
      });
      res.on('error', (err) => {
        settle(() => {
          clearTimeout(timer);
          ws.destroy();
          void fsp.unlink(dest).catch(() => {});
          reject(new KydogError('skill.network', `下载流错误：${err.message}`));
        });
      });
    });
    req.on('error', (err) => {
      settle(() => {
        clearTimeout(timer);
        ws.destroy();
        void fsp.unlink(dest).catch(() => {});
        reject(new KydogError('skill.network', `请求错误：${err.message}`));
      });
    });
  });
}
