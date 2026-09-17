import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isAgentRequested, looksLikePdf, safeFilename, assertDownloadable, assertPdfContent,
  settleDownload, tmpDownloadPath,
  MAX_DOWNLOAD_BYTES,
} from './download';
import { KydogError } from '../../shared/errors';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('isAgentRequested：放行与取消两个方向都要守', () => {
  it('chain[0] 对得上待决请求 → 放行', () => {
    const pending = new Set(['https://www.mdpi.com/2504-4990/8/9/283/pdf']);
    expect(isAgentRequested(['https://www.mdpi.com/2504-4990/8/9/283/pdf'], pending)).toBe(true);
  });

  it('重定向链只看 chain[0]：最终地址不同也认得出是同一次请求', () => {
    const pending = new Set(['https://doi.org/10.3390/make8090283']);
    const chain = ['https://doi.org/10.3390/make8090283', 'https://www.mdpi.com/…/pdf'];
    expect(isAgentRequested(chain, pending)).toBe(true);
  });

  /**
   * **这一条是另一半，缺了它整道闸等于没有。** 页面自发拉起的下载（广告 frame、
   * 站点自己的埋点）若被误放行，就会落进 `papers/`，而「下载了什么」不再可追溯到
   * 一次工具调用 —— spec §3 要挡的正是这个。
   */
  it('页面自发拉起的下载（不在待决集合里）→ 不放行', () => {
    const pending = new Set(['https://www.mdpi.com/a/pdf']);
    expect(isAgentRequested(['https://ads.example.com/tracker.pdf'], pending)).toBe(false);
  });

  it('链为空 → 不放行（不知道它从哪来就不放行）', () => {
    expect(isAgentRequested([], new Set(['https://x/y.pdf']))).toBe(false);
  });
});

describe('looksLikePdf：判据是魔数，不是 content-type', () => {
  it('以 %PDF- 开头 → 是', () => {
    expect(looksLikePdf(bytes('%PDF-1.7\n%âãÏÓ'))).toBe(true);
  });

  /**
   * **这就是要挡的那条假绿。** 2026-09-16 实测：会话外取 MDPI / PeerJ / ChemRxiv 的 PDF
   * 直链，回的是 5 KB 左右的 Cloudflare 拦截页。存成 `x.pdf` 之后文件在、大小不为零、
   * 后缀也对，只有内容是 HTML。
   */
  it('Cloudflare 拦截页（HTML）→ 不是', () => {
    expect(looksLikePdf(bytes('<!DOCTYPE html><html><head><title>请稍候…'))).toBe(false);
  });

  it('比魔数还短的一段字节 → 不是（不够判就不判成是）', () => {
    expect(looksLikePdf(bytes('%PD'))).toBe(false);
  });
});

describe('safeFilename：只保证不越界', () => {
  it('从 URL 末段推，并补上 .pdf', () => {
    expect(safeFilename('https://peerj.com/articles/21696.pdf')).toBe('21696.pdf');
    expect(safeFilename('https://www.mdpi.com/2504-4990/8/9/283/pdf')).toBe('pdf.pdf');
  });

  it('提示优先于 URL', () => {
    expect(safeFilename('https://x/y.pdf', 'flow-matching')).toBe('flow-matching.pdf');
  });

  /**
   * 否定型断言在这里先证明正向那一面：上面两条已经证明这个函数真的会产出名字，
   * 所以下面「结果里没有分隔符」不是空转。
   */
  it('穿越路径的名字被削成 basename，不会写出 papers/ 之外', () => {
    for (const evil of ['../../etc/passwd', '..', '.', '/abs/path/x.pdf', 'a\\b\\c.pdf']) {
      const out = safeFilename('https://x/y.pdf', evil);
      expect(out).not.toContain('/');
      expect(out).not.toContain('\\');
      expect(out).not.toBe('..');
      expect(out).not.toBe('.');
    }
  });
});

describe('assertDownloadable：没拿到字节与拿到了不是 PDF 要分开', () => {
  it('2xx 且在上限内 → 放行', () => {
    expect(() => assertDownloadable({ url: 'u', httpStatusCode: 200, totalBytes: 1024 })).not.toThrow();
  });

  it('403 → download_failed（不是 not_pdf）', () => {
    try {
      assertDownloadable({ url: 'u', httpStatusCode: 403, totalBytes: 5689 });
      expect.unreachable('应该抛');
    } catch (e) {
      expect(e).toBeInstanceOf(KydogError);
      expect((e as KydogError).code).toBe('browser.download_failed');
    }
  });

  it('超过单文件上限 → download_too_large，且消息里带上实际大小与上限', () => {
    try {
      assertDownloadable({ url: 'u', httpStatusCode: 200, totalBytes: MAX_DOWNLOAD_BYTES + 1 });
      expect.unreachable('应该抛');
    } catch (e) {
      expect((e as KydogError).code).toBe('browser.download_too_large');
      expect((e as KydogError).message).toContain(String(MAX_DOWNLOAD_BYTES + 1));
      expect((e as KydogError).message).toContain(String(MAX_DOWNLOAD_BYTES));
    }
  });

  it('状态码拿不到（null）时不据此定论，交给内容判据', () => {
    expect(() => assertDownloadable({ url: 'u', httpStatusCode: null, totalBytes: 10 })).not.toThrow();
  });
});

describe('assertPdfContent', () => {
  it('真 PDF → 放行', () => {
    expect(() => assertPdfContent({
      url: 'u', head: bytes('%PDF-1.4'), mimeType: 'application/pdf', bytes: 1234,
    })).not.toThrow();
  });

  /** **站点声称自己是 PDF 也不算数** —— 判据只有魔数。 */
  it('content-type 说是 application/pdf，但内容是 HTML → not_pdf', () => {
    try {
      assertPdfContent({
        url: 'u', head: bytes('<!DOCTYPE html><title>Just a moment'),
        mimeType: 'application/pdf', bytes: 5689,
      });
      expect.unreachable('应该抛');
    } catch (e) {
      expect((e as KydogError).code).toBe('browser.download_not_pdf');
      // 消息要让人看得见「实际取到了什么」，而不是只说一句「不是 PDF」
      expect((e as KydogError).message).toContain('5689');
      expect((e as KydogError).message).toContain('application/pdf');
    }
  });
});

/**
 * 落盘的两条不变量。**都是 2026-09-17 手测撞出来的**，不是预防性设计：
 *
 * A2 那一轮先下了 `arxiv.org/pdf/2210.02747`（25 MB，好的），再对 `arxiv.org/abs/2210.02747`
 * （HTML 落地页）调一次。两个地址的末段都是 `2210.02747`，推出**同一个**文件名；旧实现直接把
 * 字节写到最终路径、判不过就删最终路径 —— HTML 先盖掉了那份好 PDF，再被当成坏文件删掉。
 * 报错说的是「没有留一个坏文件」，而实际丢的是**上一轮那份好文件**。
 *
 * 同一个根因的另一面：MDPI 的直链末段恒为 `pdf`、ChinaXiv 恒为 `download.htm`，
 * 不给 `filename` 时同一个源的第二篇会**静默覆盖**第一篇。
 */
describe('settleDownload：不碰这次调用之外的任何文件', () => {
  let dir: string;
  beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kydog-dl-')); });
  afterEach(async () => { await fsp.rm(dir, { recursive: true, force: true }); });

  const exists = (p: string) => fsp.stat(p).then(() => true, () => false);

  it('同名文件已在、这次内容判不过 → 删的只是这次的临时文件，原有文件一个字节都不动', async () => {
    const original = path.join(dir, '2210.02747.pdf');
    await fsp.writeFile(original, '%PDF-1.5 the good one');
    const tmp = tmpDownloadPath(dir);
    await fsp.writeFile(tmp, '<!DOCTYPE html><html>abs page</html>');
    expect(await exists(tmp)).toBe(true);

    await expect(settleDownload({
      tmpPath: tmp, dir, url: 'https://arxiv.org/abs/2210.02747', mimeType: 'text/html',
    })).rejects.toMatchObject({ code: 'browser.download_not_pdf' });

    expect(await fsp.readFile(original, 'utf-8')).toBe('%PDF-1.5 the good one');
    expect(await exists(tmp)).toBe(false);
    expect((await fsp.readdir(dir)).sort()).toEqual(['2210.02747.pdf']);
  });

  it('同名文件已在、这次内容判过 → 另起名字，原有文件不被覆盖', async () => {
    await fsp.writeFile(path.join(dir, 'pdf.pdf'), '%PDF-1.7 first mdpi paper');
    const tmp = tmpDownloadPath(dir);
    await fsp.writeFile(tmp, '%PDF-1.7 second mdpi paper');

    const r = await settleDownload({
      tmpPath: tmp, dir, url: 'https://www.mdpi.com/1424-8220/26/18/5862/pdf', mimeType: 'application/pdf',
    });

    expect(path.basename(r.path)).toBe('pdf-2.pdf');
    expect(await fsp.readFile(path.join(dir, 'pdf.pdf'), 'utf-8')).toBe('%PDF-1.7 first mdpi paper');
    expect(await fsp.readFile(r.path, 'utf-8')).toBe('%PDF-1.7 second mdpi paper');
    expect(r.bytes).toBe('%PDF-1.7 second mdpi paper'.length);
    expect(await exists(tmp)).toBe(false);
  });

  it('给了 filename 且已被占到第 2 个 → 接着往后编号，编号插在扩展名前面', async () => {
    await fsp.writeFile(path.join(dir, 's26185862.pdf'), '%PDF-a');
    await fsp.writeFile(path.join(dir, 's26185862-2.pdf'), '%PDF-b');
    const tmp = tmpDownloadPath(dir);
    await fsp.writeFile(tmp, '%PDF-c');

    const r = await settleDownload({
      tmpPath: tmp, dir, url: 'https://www.mdpi.com/x/pdf', filename: 's26185862.pdf', mimeType: null,
    });

    expect(path.basename(r.path)).toBe('s26185862-3.pdf');
    expect(await fsp.readFile(path.join(dir, 's26185862.pdf'), 'utf-8')).toBe('%PDF-a');
    expect(await fsp.readFile(path.join(dir, 's26185862-2.pdf'), 'utf-8')).toBe('%PDF-b');
  });

  it('没有同名 → 用原名落盘，临时文件不留', async () => {
    const tmp = tmpDownloadPath(dir);
    await fsp.writeFile(tmp, '%PDF-1.5 body');
    expect(await exists(tmp)).toBe(true);

    const r = await settleDownload({
      tmpPath: tmp, dir, url: 'https://arxiv.org/pdf/2210.02747', mimeType: 'application/pdf',
    });

    expect(r.path).toBe(path.join(dir, '2210.02747.pdf'));
    expect(await fsp.readFile(r.path, 'utf-8')).toBe('%PDF-1.5 body');
    expect(await exists(tmp)).toBe(false);
  });

  it('临时文件在目标目录里（rename 才是原子的），且不会被当成一篇 PDF', () => {
    const tmp = tmpDownloadPath(dir);
    expect(path.dirname(tmp)).toBe(dir);
    expect(path.basename(tmp).startsWith('.')).toBe(true);
    expect(tmp.toLowerCase().endsWith('.pdf')).toBe(false);
    expect(tmpDownloadPath(dir)).not.toBe(tmp);
  });
});
