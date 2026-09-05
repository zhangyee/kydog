import { describe, it, expect, vi } from 'vitest';
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

  it('重试后仍失败 → 该页无块（保留原文）且 failed 计数 +1', async () => {
    let last = 0;
    const doc = await translateDoc(base({
      numPages: 2,
      translatePage: async ({ page }: { page: number }) =>
        (page === 2 ? { text: 'garbage', truncated: false } : { text: '1 | text\nT1\n%%\n', truncated: false }),
      onProgress: (p) => { last = p.failed; },
    }));
    expect(doc!.blocks.map((b) => b.page)).toEqual([1]);
    expect(last).toBe(1);
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
