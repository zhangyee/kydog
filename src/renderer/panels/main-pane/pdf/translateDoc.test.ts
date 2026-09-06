import { describe, it, expect, vi } from 'vitest';
import type { TranslatedDoc } from '../../../../shared/zhSidecar';
import { PAGE_CONCURRENCY, translateDoc } from './translateDoc';

// 每页一行，文本是 "p{n}"；行几何互不重叠，几何校验必过
const fakePage = (n: number, count = 1) => ({
  getTextContent: async () => ({
    items: Array.from({ length: count }, (_, i) => ({
      str: `p${n}l${i + 1}`, transform: [10, 0, 0, 10, 72, 300 - i * 14], width: 40, height: 10, hasEOL: true,
    })),
  }),
  getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, 400 - y] }),
});

const base = (over: Partial<Parameters<typeof translateDoc>[0]> = {}) => ({
  numPages: 3,
  getPage: async (n: number) => fakePage(n),
  translatePage: async ({ page }: { page: number }) => ({ text: `1 | text\nT${page}\n%%\n`, truncated: false }),
  onProgress: () => {},
  isCancelled: () => false,
  pdfName: 'p.pdf',
  langOut: 'zh',
  source: { sha256: 'ab', bytes: 1 },
  ...over,
});

describe('translateDoc', () => {
  it('组装出完整的 TranslatedDoc', async () => {
    const doc = await translateDoc(base());
    expect(doc!.version).toBe(1);
    expect(doc!.lang).toEqual({ in: 'auto', out: 'zh' });
    expect(doc!.source).toEqual({ sha256: 'ab', bytes: 1 });
    expect(doc!.blocks.map((b) => [b.page, b.target])).toEqual([[1, 'T1'], [2, 'T2'], [3, 'T3']]);
  });

  it('onPageExtracted 交出的就是 getPage 返回的那个 proxy 本身（调用方要拿它 cleanup）', async () => {
    // 不变量 #8：抽完的页若不在渲染窗口内，调用方要对它调 page.cleanup() 把 pdf.js 的解码
    // 缓存还回去。调用方回自己那张 proxy 表里找是不行的——翻译这条路的页是现取的，多数根本
    // 不在表里。所以这里钉的是**对象同一性**：交出去的必须是刚抽完的那一个，不是等价物。
    const made: { page: number; proxy: object }[] = [];
    const got: { page: number; source: unknown }[] = [];
    await translateDoc(base({
      getPage: async (n: number) => { const p = fakePage(n); made.push({ page: n, proxy: p }); return p; },
      onPageExtracted: (page: number, _text: unknown, source: unknown) => { got.push({ page, source }); },
    }));
    expect(got.map((g) => g.page)).toEqual([1, 2, 3]);
    // 每页只取一次 proxy：再取一次也能拿到「一个第 n 页的 proxy」，但那是个**没被抽过**的新
    // 对象，对它 cleanup() 什么都没还回去——所以「取了几次」和「交出去的是哪一个」要一起钉。
    expect(made.map((m) => m.page)).toEqual([1, 2, 3]);
    for (const g of got) expect(g.source).toBe(made.find((m) => m.page === g.page)!.proxy);
  });

  it('全文档零行 → 抛错，一次调用都不发', async () => {
    const translatePage = vi.fn();
    await expect(translateDoc(base({
      getPage: async () => ({ getTextContent: async () => ({ items: [] }), getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, y] }) }),
      translatePage,
    }))).rejects.toThrow(/文本层/);
    expect(translatePage).not.toHaveBeenCalled();
  });

  it('零行的页不发请求，非零的照发', async () => {
    const seen: number[] = [];
    await translateDoc(base({
      getPage: async (n: number) => (n === 2
        ? { getTextContent: async () => ({ items: [] }), getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, y] }) }
        : fakePage(n)),
      translatePage: async ({ page }: { page: number }) => { seen.push(page); return { text: `1 | text\nT${page}\n%%\n`, truncated: false }; },
    }));
    expect(seen.sort()).toEqual([1, 3]);
  });

  it('单页抽取失败 → 整趟中止，不返回 doc', async () => {
    await expect(translateDoc(base({
      getPage: async (n: number) => (n === 2 ? { getTextContent: async () => { throw new Error('worker died'); }, getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, y] }) } : fakePage(n)),
    }))).rejects.toThrow('worker died');
  });

  it('一次校验失败、重试后成功 → 不计入 failed', async () => {
    let first = true;
    const progress: number[] = [];
    const doc = await translateDoc(base({
      numPages: 1,
      translatePage: async () => {
        if (first) { first = false; return { text: 'garbage', truncated: false }; }
        return { text: '1 | text\nOK\n%%\n', truncated: false };
      },
      onProgress: (p) => progress.push(p.failed),
    }));
    expect(doc!.blocks[0].target).toBe('OK');
    expect(progress.at(-1)).toBe(0);
  });

  it('重试后仍失败 → 该页无块（保留原文）、failed 计数 +1，且页号记进边车', async () => {
    let last = 0;
    const doc = await translateDoc(base({
      numPages: 2,
      translatePage: async ({ page }: { page: number }) =>
        (page === 2 ? { text: 'garbage', truncated: false } : { text: '1 | text\nT1\n%%\n', truncated: false }),
      onProgress: (p) => { last = p.failed; },
    }));
    expect(doc!.blocks.map((b) => b.page)).toEqual([1]);
    expect(last).toBe(1);
    // 计数只是 onProgress 上的瞬时读数；**能活过这趟作业的是边车里这份页号**（Notice 从 doc
    // 现读）。「第 2 页失败」这件事必须显式在这里，不能靠「哪几页没有块」反推——零行页同样没块。
    expect(doc!.failedPages).toEqual([2]);
  });

  it('多页失败 → 页号升序，与并发完成次序无关', async () => {
    // 页是并发跑的，push 的次序是完成次序。这里让第 4 页比第 2 页先落地（第 2 页多绕两个
    // 微任务），断言写进边车的仍是 [2, 4]——同样的输入不该写出不同的文件。
    const doc = await translateDoc(base({
      numPages: 4,
      translatePage: async ({ page }: { page: number }) => {
        if (page === 2) { await Promise.resolve(); await Promise.resolve(); return { text: 'garbage', truncated: false }; }
        if (page === 4) return { text: 'garbage', truncated: false };
        return { text: `1 | text\nT${page}\n%%\n`, truncated: false };
      },
    }));
    expect(doc!.failedPages).toEqual([2, 4]);
  });

  it('一页都没失败 → 边车里没有 failedPages 这个字段', async () => {
    // 缺省就是「没有失败页」。写成 `failedPages: []` 会让每份边车都多一行噪声，也让
    // 「有没有这个字段」与「有没有失败页」不再是同一件事。
    const doc = await translateDoc(base());
    expect(doc!.failedPages).toBeUndefined();
    expect(Object.keys(doc!)).not.toContain('failedPages');
  });

  describe('failureReasons', () => {
    it('两次都失败 → 边车里有该页的两次报错文本；成功页没有条目', async () => {
      const doc = await translateDoc(base({
        numPages: 2,
        translatePage: async ({ page }) => ({
          text: page === 2 ? 'no bar here' : '1 | text\nT\n%%\n', truncated: false,
        }),
      }));
      expect(doc!.failedPages).toEqual([2]);
      expect(Object.keys(doc!.failureReasons!)).toEqual(['2']);
      expect(doc!.failureReasons!['2']).toMatch(/组头缺少 "\|"/);
      expect(doc!.failureReasons!['2']).toMatch(/；重试：/);
    });
    it('一页都没失败 → 没有 failureReasons 这个键', async () => {
      const doc = await translateDoc(base());
      expect('failureReasons' in doc!).toBe(false);
    });
  });

  it('截断 → 对半拆重试，递归到单行', async () => {
    const calls: number[] = [];
    const doc = await translateDoc(base({
      numPages: 1,
      getPage: async (n: number) => fakePage(n, 4),
      translatePage: async ({ lines }: { lines: { n: number }[] }) => {
        calls.push(lines.length);
        if (lines.length > 1) return { text: '', truncated: true };
        return { text: `${lines[0].n} | text\nT${lines[0].n}\n%%\n`, truncated: false };
      },
    }));
    expect(calls).toEqual([4, 2, 1, 1, 2, 1, 1]);
    expect(doc!.blocks).toHaveLength(4);
  });

  it('单行仍截断 → 该页记失败', async () => {
    let last = 0;
    const doc = await translateDoc(base({
      numPages: 1,
      translatePage: async () => ({ text: '', truncated: true }),
      onProgress: (p) => { last = p.failed; },
    }));
    expect(doc!.blocks).toEqual([]);
    expect(last).toBe(1);
  });

  it('docTitle 从第 1 页传播到其余页，且第 1 页先单跑', async () => {
    const titles: (string | undefined)[] = [];
    await translateDoc(base({
      numPages: 3,
      translatePage: async ({ page, docTitle }: { page: number; docTitle?: string }) => {
        titles.push(docTitle);
        return page === 1 ? { text: '1 | title\n标题\n%%\n', truncated: false } : { text: '1 | text\nX\n%%\n', truncated: false };
      },
    }));
    expect(titles[0]).toBeUndefined();
    expect(titles.slice(1)).toEqual(['p1l1', 'p1l1']);
  });

  it('并发不超过 PAGE_CONCURRENCY', async () => {
    let inFlight = 0; let peak = 0;
    await translateDoc(base({
      numPages: 20,
      translatePage: async ({ page }: { page: number }) => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        return { text: `1 | text\nT${page}\n%%\n`, truncated: false };
      },
    }));
    // 断言 toBe 而不是 toBeLessThanOrEqual：<= 在实现完全串行（peak 恒为 1）时也绿，
    // 而「把 Promise.all 误改成串行 for」的用户可见后果是翻译慢 4 倍。peak 恒等于 4 是确定的
    // ——Array.from 同步依次调 4 个 worker，到 fake 内部的 await 才第一次挂起，4 次 inFlight++
    // 落在同一个同步段里。不引入任何时间阈值。
    expect(peak).toBe(PAGE_CONCURRENCY);
  });

  it('取消后不再发起新页，返回 null', async () => {
    let cancelled = false; const seen: number[] = [];
    const doc = await translateDoc(base({
      numPages: 20,
      isCancelled: () => cancelled,
      translatePage: async ({ page }: { page: number }) => {
        seen.push(page);
        if (seen.length >= 5) cancelled = true;
        return { text: `1 | text\nT${page}\n%%\n`, truncated: false };
      },
    }));
    expect(doc).toBeNull();
    // 同上，`< 20` 弱到「每 10 页才检查一次取消」也能绿。seen 恒为 [1,2,3,4,5] 是确定的：
    // head 先跑第 1 页，4 个 worker 同步各推一页（2/3/4/5），第 5 次推入时置 cancelled，
    // 微任务展开后四个 worker 都在派发前的检查点退出。这条同时钉住「取消后不再发新页」
    // 与「在飞上界 = PAGE_CONCURRENCY」——后者原先没有任何断言在守。
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it('llm.not_configured 不重试，直接抛出中止整趟', async () => {
    const translatePage = vi.fn(async () => {
      const e = new Error('没有可用的模型') as Error & { code?: string };
      e.code = 'llm.not_configured';
      throw e;
    });
    await expect(translateDoc(base({ numPages: 3, translatePage }))).rejects.toThrow('没有可用的模型');
    expect(translatePage).toHaveBeenCalledTimes(1);
  });

  it('第一次校验失败触发重试、第二次才遇到 llm.not_configured → 中止整趟，不计入 failed', async () => {
    let calls = 0;
    const progress: number[] = [];
    await expect(translateDoc(base({
      numPages: 1,
      translatePage: async () => {
        calls++;
        if (calls === 1) return { text: 'garbage', truncated: false };
        const e = new Error('没有可用的模型') as Error & { code?: string };
        e.code = 'llm.not_configured';
        throw e;
      },
      onProgress: (p) => progress.push(p.failed),
    }))).rejects.toThrow('没有可用的模型');
    expect(calls).toBe(2);
    // 没有任何一次 onProgress 把 failed 报成 1——这页是被中止代码路径（throw e2）带走的，
    // 不是普通的「重试仍失败」（那条路径才该把 failed++）。
    expect(progress).not.toContain(1);
  });
});

describe('划分缺行 → 补漏一次（spec 2026-09-06 §4.1）', () => {
  it('只把缺的那几行再发一次，合并后成功、不计失败', async () => {
    const calls: number[][] = [];
    const doc = await translateDoc(base({
      numPages: 1,
      getPage: async (n: number) => fakePage(n, 3),
      translatePage: async ({ lines }) => {
        calls.push(lines.map((l) => l.n));
        if (lines.length === 3) return { text: '1-2 | text\nT\n%%\n', truncated: false };   // 漏了 3
        return { text: '3 | skip\n%%\n', truncated: false };
      },
    }));
    expect(calls).toEqual([[1, 2, 3], [3]]);
    expect(doc!.failedPages).toBeUndefined();
    expect(doc!.blocks.map((b) => [b.kind, b.target])).toEqual([['text', 'T'], ['skip', undefined]]);
  });

  it('补漏那一趟又漏 → 整页重试（第三次调用收到整页）', async () => {
    const calls: number[][] = [];
    let full = 0;
    const doc = await translateDoc(base({
      numPages: 1,
      getPage: async (n: number) => fakePage(n, 3),
      translatePage: async ({ lines }) => {
        calls.push(lines.map((l) => l.n));
        if (lines.length === 3) {
          full++;
          return { text: full === 1 ? '1-2 | text\nT\n%%\n' : '1-3 | text\nT\n%%\n', truncated: false };
        }
        return { text: '', truncated: false };   // 补漏那趟什么都没回
      },
    }));
    expect(calls).toEqual([[1, 2, 3], [3], [1, 2, 3]]);
    expect(doc!.failedPages).toBeUndefined();
  });

  it('什么都没回来（缺的就是全部）→ 不补漏，直接整页重试', async () => {
    const calls: number[][] = [];
    let n = 0;
    await translateDoc(base({
      numPages: 1,
      getPage: async (p: number) => fakePage(p, 2),
      translatePage: async ({ lines }) => {
        calls.push(lines.map((l) => l.n));
        n++;
        return { text: n === 1 ? '' : '1-2 | text\nT\n%%\n', truncated: false };
      },
    }));
    expect(calls).toEqual([[1, 2], [1, 2]]);
  });

  it('截断对半拆之后，两半各自补漏', async () => {
    const calls: number[][] = [];
    const doc = await translateDoc(base({
      numPages: 1,
      getPage: async (p: number) => fakePage(p, 4),
      translatePage: async ({ lines }) => {
        const ids = lines.map((l) => l.n);
        calls.push(ids);
        if (ids.length === 4) return { text: '', truncated: true };
        if (ids.join() === '1,2') return { text: '1 | text\nA\n%%\n', truncated: false };   // 漏 2
        if (ids.join() === '2') return { text: '2 | skip\n%%\n', truncated: false };
        return { text: '3-4 | text\nB\n%%\n', truncated: false };
      },
    }));
    expect(calls).toEqual([[1, 2, 3, 4], [1, 2], [2], [3, 4]]);
    expect(doc!.failedPages).toBeUndefined();
    expect(doc!.blocks.map((b) => b.kind)).toEqual(['text', 'skip', 'text']);
  });
});

describe('部分页：pages + base（spec 2026-09-06 §4.3）', () => {
  const BASE: TranslatedDoc = {
    version: 1, pdf: 'p.pdf', lang: { in: 'auto', out: 'zh' },
    source: { sha256: 'old', bytes: 1 }, glossary: [{ source: 'a', target: 'b' }],
    failedPages: [2, 3], failureReasons: { '2': 'x', '3': 'y' },
    blocks: [
      { id: 'p1-b01', page: 1, x: 72, y: 100, width: 40, height: 10, fontSize: 10, kind: 'title', source: 'My Title', target: '标题' },
      { id: 'p4-b01', page: 4, x: 72, y: 100, width: 40, height: 10, fontSize: 10, kind: 'text', source: 'p4l1', target: 'T4' },
    ],
  };

  it('只抽取、只翻 pages 里的页；进度 total 是 pages 的长度', async () => {
    const got: number[] = [];
    const translated: number[] = [];
    const extracts: number[] = [];
    await translateDoc(base({
      numPages: 4, pages: [2, 3], base: BASE,
      getPage: async (n: number) => { got.push(n); return fakePage(n); },
      translatePage: async ({ page }) => { translated.push(page); return { text: '1 | text\nT\n%%\n', truncated: false }; },
      onProgress: (p) => { if (p.phase === 'extract') extracts.push(p.total); },
    }));
    expect(got).toEqual([2, 3]);
    expect(translated.sort()).toEqual([2, 3]);
    expect(new Set(extracts)).toEqual(new Set([2]));
  });

  it('合并：pages 之外的块逐字不变，failedPages / failureReasons 先删再并，source 是当前摘要', async () => {
    const doc = await translateDoc(base({
      numPages: 4, pages: [2, 3], base: BASE, glossary: BASE.glossary,
      translatePage: async ({ page }) => ({
        text: page === 3 ? 'no bar' : '1 | text\nNEW\n%%\n', truncated: false,   // 3 两次都失败
      }),
    }));
    expect(doc!.blocks.map((b) => b.id)).toEqual(['p1-b01', 'p2-b01', 'p4-b01']);
    expect(doc!.blocks[0]).toEqual(BASE.blocks[0]);
    expect(doc!.blocks[2]).toEqual(BASE.blocks[1]);
    expect(doc!.blocks[1].target).toBe('NEW');
    expect(doc!.failedPages).toEqual([3]);
    expect(doc!.failureReasons).toEqual({ '3': expect.stringMatching(/组头缺少/) });
    expect(doc!.source).toEqual({ sha256: 'ab', bytes: 1 });
    expect(doc!.glossary).toEqual(BASE.glossary);
  });

  it('全部救回 → failedPages / failureReasons 两个键都不再出现', async () => {
    const doc = await translateDoc(base({ numPages: 4, pages: [2, 3], base: BASE }));
    expect('failedPages' in doc!).toBe(false);
    expect('failureReasons' in doc!).toBe(false);
  });

  it('底本只有 failedPages 没有 failureReasons、这趟全成功 → 不写出空的 failureReasons: {}（M-6）', async () => {
    // 陈旧边车可能是早于 failureReasons 存在时写的、或被 agent 手改过：failedPages 有条目、
    // failureReasons 整个键都不在。这趟只重跑 pages 之外的第 3 页且全成功，第 2 页的陈旧失败
    // 原样留着——不该凭空多出一个没有任何内容的 failureReasons 对象。
    const baseNoReasons: TranslatedDoc = {
      version: 1, pdf: 'p.pdf', lang: { in: 'auto', out: 'zh' },
      source: { sha256: 'old', bytes: 1 }, failedPages: [2],
      blocks: [
        { id: 'p1-b01', page: 1, x: 72, y: 100, width: 40, height: 10, fontSize: 10, kind: 'title', source: 'My Title', target: '标题' },
      ],
    };
    const doc = await translateDoc(base({ numPages: 4, pages: [3], base: baseNoReasons }));
    expect(doc!.failedPages).toEqual([2]);
    expect('failureReasons' in doc!).toBe(false);
  });

  it('docTitle 取 base 里第一个 title 块的 source，不再单跑第 1 页', async () => {
    const titles: (string | undefined)[] = [];
    await translateDoc(base({
      numPages: 4, pages: [2], base: BASE,
      translatePage: async ({ docTitle }) => { titles.push(docTitle); return { text: '1 | text\nT\n%%\n', truncated: false }; },
    }));
    expect(titles).toEqual(['My Title']);
  });

  it('给了 pages 没给 base → 抛', async () => {
    await expect(translateDoc(base({ numPages: 4, pages: [2] }))).rejects.toThrow('pages 需要 base');
  });

  it('pages 里全是零行页（纯图页上点「重译本页」）→ 不发请求，底本原样返回、只盖上当前摘要', async () => {
    const translatePage = vi.fn();
    const doc = await translateDoc(base({
      numPages: 4, pages: [2], base: BASE, translatePage,
      getPage: async () => ({ getTextContent: async () => ({ items: [] }), getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, y] }) }),
    }));
    expect(translatePage).not.toHaveBeenCalled();
    expect(doc!.blocks).toEqual(BASE.blocks);
    expect(doc!.failedPages).toEqual(BASE.failedPages);
    expect(doc!.source).toEqual({ sha256: 'ab', bytes: 1 });
  });
});
