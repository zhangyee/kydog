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

/** 第一步的默认假实现：每行一个 text 组。 */
const layoutOk = async ({ lines }: { lines: { n: number }[] }) =>
  ({ text: lines.map((l) => `${l.n} | text`).join('\n'), truncated: false });
/** 第二步的默认假实现：每组译文 `T<page>`。 */
const translateOk = async ({ page, groups }: { page: number; groups: { id: string }[] }) =>
  ({ text: groups.map((g) => `${g.id}\nT${page}\n%%`).join('\n'), truncated: false });

const base = (over: Partial<Parameters<typeof translateDoc>[0]> = {}) => ({
  numPages: 3,
  getPage: async (n: number) => fakePage(n),
  layoutPage: layoutOk,
  translateGroups: translateOk,
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
    const layoutPage = vi.fn();
    const translateGroups = vi.fn();
    await expect(translateDoc(base({
      getPage: async () => ({ getTextContent: async () => ({ items: [] }), getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, y] }) }),
      layoutPage,
      translateGroups,
    }))).rejects.toThrow(/文本层/);
    expect(layoutPage).not.toHaveBeenCalled();
    expect(translateGroups).not.toHaveBeenCalled();
  });

  it('零行的页不发请求，非零的照发', async () => {
    const seen: number[] = [];
    await translateDoc(base({
      getPage: async (n: number) => (n === 2
        ? { getTextContent: async () => ({ items: [] }), getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, y] }) }
        : fakePage(n)),
      layoutPage: async (a) => { seen.push(a.page); return layoutOk(a); },
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
      translateGroups: async (a) => {
        if (first) { first = false; return { text: 'no header', truncated: false }; }
        return translateOk(a);
      },
      onProgress: (p) => progress.push(p.failed),
    }));
    expect(doc!.blocks[0].target).toBe('T1');
    expect(progress.at(-1)).toBe(0);
  });

  it('重试后仍失败 → 该页无块（保留原文）、failed 计数 +1，且页号记进边车', async () => {
    let last = 0;
    const doc = await translateDoc(base({
      numPages: 2,
      translateGroups: async (a) => (a.page === 2 ? { text: 'no header', truncated: false } : translateOk(a)),
      onProgress: (p) => { last = p.failed; },
    }));
    expect(doc!.blocks.map((b) => b.page)).toEqual([1]);
    expect(last).toBe(1);
    // 计数只是 onProgress 上的瞬时读数；**能活过这趟作业的是边车里这份页号**（Notice 从 doc
    // 现读）。「第 2 页失败」这件事必须显式在这里，不能靠「哪几页没有块」反推——零行页同样没块。
    expect(doc!.failedPages).toEqual([2]);
    expect(doc!.failureReasons!['2']).toMatch(/^翻译：/);
  });

  it('多页失败 → 页号升序，与并发完成次序无关', async () => {
    // 页是并发跑的，push 的次序是完成次序。这里让第 4 页比第 2 页先落地（第 2 页多绕两个
    // 微任务），断言写进边车的仍是 [2, 4]——同样的输入不该写出不同的文件。
    const doc = await translateDoc(base({
      numPages: 4,
      translateGroups: async (a) => {
        if (a.page === 2) { await Promise.resolve(); await Promise.resolve(); return { text: 'no header', truncated: false }; }
        if (a.page === 4) return { text: 'no header', truncated: false };
        return translateOk(a);
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
        translateGroups: async (a) => (a.page === 2 ? { text: 'no header', truncated: false } : translateOk(a)),
      }));
      expect(doc!.failedPages).toEqual([2]);
      expect(Object.keys(doc!.failureReasons!)).toEqual(['2']);
      expect(doc!.failureReasons!['2']).toMatch(/^翻译：.*；重试：/);
    });
    it('一页都没失败 → 没有 failureReasons 这个键', async () => {
      const doc = await translateDoc(base());
      expect('failureReasons' in doc!).toBe(false);
    });
  });

  it('截断 → 对半拆重试（拆一层）', async () => {
    // 名字与断言对齐：这个假实现只在 4 行时判截断，拆开后的两个 2 行组不再截断，所以只拆了
    // 一层——不是递归到单行。序列断言（[[1,2,3,4],[1,2],[3,4]]）本身就是唯一的事实来源。
    const layouts: number[][] = [];
    const translates: number[] = [];
    const doc = await translateDoc(base({
      numPages: 1,
      getPage: async (n: number) => fakePage(n, 4),
      layoutPage: async (a) => {
        layouts.push(a.lines.map((l) => l.n));
        if (a.lines.length > 2) return { text: '', truncated: true };
        return layoutOk(a);
      },
      translateGroups: async (a) => { translates.push(a.groups.length); return translateOk(a); },
    }));
    expect(layouts).toEqual([[1, 2, 3, 4], [1, 2], [3, 4]]);
    // 第二步是对**合并后的整页**发的一次调用：拆分只发生在第一步内部。
    expect(translates).toEqual([4]);
    expect(doc!.blocks).toHaveLength(4);
  });

  it('单行仍截断 → 该页记失败', async () => {
    let last = 0;
    const doc = await translateDoc(base({
      numPages: 1,
      layoutPage: async () => ({ text: '', truncated: true }),
      onProgress: (p) => { last = p.failed; },
    }));
    expect(doc!.blocks).toEqual([]);
    expect(last).toBe(1);
    expect(doc!.failureReasons!['1']).toMatch(/^版面：/);
  });

  it('docTitle 从第 1 页传播到其余页，且第 1 页先单跑', async () => {
    const calls: { fn: 'layout' | 'translate'; page: number; docTitle?: string }[] = [];
    await translateDoc(base({
      numPages: 3,
      layoutPage: async (a) => {
        calls.push({ fn: 'layout', page: a.page, docTitle: a.docTitle });
        return a.page === 1 ? { text: '1 | title', truncated: false } : layoutOk(a);
      },
      translateGroups: async (a) => {
        calls.push({ fn: 'translate', page: a.page, docTitle: a.docTitle });
        return translateOk(a);
      },
    }));
    // 第 1 页的版面先于其它页的任何调用：文题要在第 1 页的**第二步**之前就确定。
    expect(calls[0]).toEqual({ fn: 'layout', page: 1, docTitle: undefined });
    // 第 1 页只跑一次版面：拿文题那趟的结果直接复用，不多付一次调用。
    expect(calls.filter((c) => c.page === 1)).toEqual([
      { fn: 'layout', page: 1, docTitle: undefined },
      { fn: 'translate', page: 1, docTitle: 'p1l1' },
    ]);
    expect(calls.filter((c) => c.page !== 1).map((c) => c.docTitle)).toEqual(['p1l1', 'p1l1', 'p1l1', 'p1l1']);
  });

  it('并发不超过 PAGE_CONCURRENCY', async () => {
    let inFlight = 0; let peak = 0;
    // 两个入口一起计 in-flight：界的是「一趟里已发出未落地的上游请求」，不分是哪一步。
    const busy = async <T>(fn: () => Promise<T>): Promise<T> => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return fn();
    };
    await translateDoc(base({
      numPages: 20,
      layoutPage: (a) => busy(() => layoutOk(a)),
      translateGroups: (a) => busy(() => translateOk(a)),
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
      layoutPage: async (a) => {
        seen.push(a.page);
        if (seen.length >= 5) cancelled = true;
        return layoutOk(a);
      },
    }));
    expect(doc).toBeNull();
    // 同上，`< 20` 弱到「每 10 页才检查一次取消」也能绿。seen 恒为 [1,2,3,4,5] 是确定的：
    // head 先跑第 1 页，4 个 worker 同步各推一页（2/3/4/5），第 5 次推入时置 cancelled，
    // 微任务展开后四个 worker 都在派发前的检查点退出。这条同时钉住「取消后不再发新页」
    // 与「在飞上界 = PAGE_CONCURRENCY」——后者原先没有任何断言在守。
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it('版面已回、第二步还没发时取消 → 不再发第二步，返回 null（I-1）', async () => {
    // 版面这一步成功之后、构造第二步请求之前必须再查一次 isCancelled()——否则取消之后在途页
    // 仍会白付一次翻译调用（付费调用上界因此从 ≤4 变成 ≤12，见 translateDoc.ts 顶部注释）。
    // layoutPage 在返回前把 cancelled 翻转，模拟「取消发生在版面结果落地之后」这个时序。
    let cancelled = false;
    const translateGroups = vi.fn();
    const doc = await translateDoc(base({
      numPages: 1,
      isCancelled: () => cancelled,
      layoutPage: async (a) => { const r = await layoutOk(a); cancelled = true; return r; },
      translateGroups,
    }));
    expect(translateGroups).not.toHaveBeenCalled();
    expect(doc).toBeNull();
  });

  it('llm.not_configured 不重试，直接抛出中止整趟', async () => {
    const layoutPage = vi.fn(async () => {
      const e = new Error('没有可用的模型') as Error & { code?: string };
      e.code = 'llm.not_configured';
      throw e;
    });
    await expect(translateDoc(base({ numPages: 3, layoutPage }))).rejects.toThrow('没有可用的模型');
    expect(layoutPage).toHaveBeenCalledTimes(1);
  });

  it('第一次校验失败触发重试、第二次才遇到 llm.not_configured → 中止整趟，不计入 failed', async () => {
    let calls = 0;
    const progress: number[] = [];
    await expect(translateDoc(base({
      numPages: 1,
      translateGroups: async () => {
        calls++;
        if (calls === 1) return { text: 'no header', truncated: false };
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
    const translates: string[][] = [];
    const doc = await translateDoc(base({
      numPages: 1,
      getPage: async (n: number) => fakePage(n, 3),
      layoutPage: async ({ lines }) => {
        calls.push(lines.map((l) => l.n));
        if (lines.length === 3) return { text: '1-2 | text', truncated: false };   // 漏了 3
        return { text: '3 | skip', truncated: false };
      },
      translateGroups: async (a) => { translates.push(a.groups.map((g) => g.id)); return translateOk(a); },
    }));
    expect(calls).toEqual([[1, 2, 3], [3]]);
    expect(doc!.failedPages).toBeUndefined();
    expect(doc!.blocks.map((b) => [b.kind, b.target])).toEqual([['text', 'T1'], ['skip', undefined]]);
    // 补漏只在第一步内部发生：第二步拿到的是合并后的整页，只发一次。
    expect(translates).toEqual([['g1']]);
  });

  it('补漏那一趟又漏 → 整页重试（第三次调用收到整页）', async () => {
    const calls: number[][] = [];
    let full = 0;
    const doc = await translateDoc(base({
      numPages: 1,
      getPage: async (n: number) => fakePage(n, 3),
      layoutPage: async ({ lines }) => {
        calls.push(lines.map((l) => l.n));
        if (lines.length === 3) {
          full++;
          return { text: full === 1 ? '1-2 | text' : '1-3 | text', truncated: false };
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
      layoutPage: async ({ lines }) => {
        calls.push(lines.map((l) => l.n));
        n++;
        return { text: n === 1 ? '' : '1-2 | text', truncated: false };
      },
    }));
    expect(calls).toEqual([[1, 2], [1, 2]]);
  });

  it('截断对半拆之后，两半各自补漏', async () => {
    const calls: number[][] = [];
    const translates: string[][] = [];
    const doc = await translateDoc(base({
      numPages: 1,
      getPage: async (p: number) => fakePage(p, 4),
      layoutPage: async ({ lines }) => {
        const ids = lines.map((l) => l.n);
        calls.push(ids);
        if (ids.length === 4) return { text: '', truncated: true };
        if (ids.join() === '1,2') return { text: '1 | text', truncated: false };   // 漏 2
        if (ids.join() === '2') return { text: '2 | skip', truncated: false };
        return { text: '3-4 | text', truncated: false };
      },
      translateGroups: async (a) => { translates.push(a.groups.map((g) => g.id)); return translateOk(a); },
    }));
    expect(calls).toEqual([[1, 2, 3, 4], [1, 2], [2], [3, 4]]);
    expect(doc!.failedPages).toBeUndefined();
    expect(doc!.blocks.map((b) => b.kind)).toEqual(['text', 'skip', 'text']);
    expect(translates).toEqual([['g1', 'g2']]);
  });
});

describe('第二步译文多出原文没有的 \\ / $（spec 2026-09-07 §8.8）', () => {
  it('只把违约的那几组再发一次，第二次干净就用第二次的；干净的组不重发', async () => {
    const calls: string[][] = [];
    let n = 0;
    const doc = await translateDoc(base({
      numPages: 1, getPage: async (p) => fakePage(p, 2),
      layoutPage: async () => ({ text: '1 | text\n2 | text', truncated: false }),
      translateGroups: async ({ groups }) => {
        calls.push(groups.map((g) => g.id));
        n++;
        if (n === 1) return { text: 'g1\n甲 \\( v_n \\)\n%%\ng2\n乙\n%%', truncated: false };
        return { text: 'g1\n甲 𝑣𝑛\n%%', truncated: false };
      },
    }));
    expect(calls).toEqual([['g1', 'g2'], ['g1']]);
    expect(doc!.failedPages).toBeUndefined();
    expect(doc!.blocks.map((b) => b.target)).toEqual(['甲 𝑣𝑛', '乙']);
  });

  it('违约的就是全部 → 不补漏、整步重试；两次都这样 → 页失败，原因写明是 LaTeX', async () => {
    const translateGroups = vi.fn(async () => ({ text: 'g1\n甲 $x_i$\n%%', truncated: false }));
    const doc = await translateDoc(base({
      numPages: 1, getPage: async (p) => fakePage(p, 1),
      layoutPage: async () => ({ text: '1 | text', truncated: false }),
      translateGroups,
    }));
    expect(translateGroups).toHaveBeenCalledTimes(2);
    expect(doc!.blocks).toEqual([]);
    expect(doc!.failedPages).toEqual([1]);
    expect(doc!.failureReasons!['1']).toMatch(/^翻译：组 g1 的译文出现了原文没有的.*LaTeX.*；重试：/);
  });

  it('原文本身带反斜杠 → 译文带它不算违约、不重发', async () => {
    const page = {
      getTextContent: async () => ({
        items: [{ str: 'escape as \\n', transform: [10, 0, 0, 10, 72, 300], width: 40, height: 10, hasEOL: true }],
      }),
      getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, 400 - y] }),
    };
    const translateGroups = vi.fn(async () => ({ text: 'g1\n转义为 \\n\n%%', truncated: false }));
    const doc = await translateDoc(base({
      numPages: 1, getPage: async () => page,
      layoutPage: async () => ({ text: '1 | text', truncated: false }),
      translateGroups,
    }));
    expect(translateGroups).toHaveBeenCalledTimes(1);
    expect(doc!.blocks.map((b) => b.target)).toEqual(['转义为 \\n']);
  });
});

describe('两步协议（spec 2026-09-07 §4）', () => {
  it('第二步只收到可译组，id 按阅读顺序 g1..gN，source 是 tokenize().request', async () => {
    const got: unknown[] = [];
    await translateDoc(base({
      numPages: 1,
      getPage: async (n) => fakePage(n, 4),
      layoutPage: async () => ({ text: '1-2 | text\n3 | code\n4 | title', truncated: false }),
      translateGroups: async ({ groups }) => { got.push(groups); return { text: 'g1\nA\n%%\ng2\nB\n%%', truncated: false }; },
    }));
    expect(got).toEqual([[
      { id: 'g1', kind: 'text', source: 'p1l1 p1l2' },
      { id: 'g2', kind: 'title', source: 'p1l4' },
    ]]);
  });

  it('code 组不进第二步、边车里没有 target；整页只有不可译组 → 第二步不调', async () => {
    const translateGroups = vi.fn();
    const doc = await translateDoc(base({
      numPages: 1, getPage: async (n) => fakePage(n, 2),
      layoutPage: async () => ({ text: '1-2 | code', truncated: false }),
      translateGroups,
    }));
    expect(translateGroups).not.toHaveBeenCalled();
    expect(doc!.blocks.map((b) => [b.kind, b.target])).toEqual([['code', undefined]]);
    expect(doc!.failedPages).toBeUndefined();
  });

  it('第二步失败只重跑第二步，第一步不重跑', async () => {
    let layouts = 0; let translates = 0;
    const doc = await translateDoc(base({
      numPages: 1,
      layoutPage: async (a) => { layouts++; return layoutOk(a); },
      translateGroups: async (a) => { translates++; return translates === 1 ? { text: 'garbage', truncated: false } : translateOk(a); },
    }));
    expect(layouts).toBe(1);
    expect(translates).toBe(2);
    expect(doc!.failedPages).toBeUndefined();
  });

  it('第二步缺一组 → 只把缺的组再发一次并合并；补漏那趟再缺 → 整个第二步重试', async () => {
    const calls: string[][] = [];
    const doc = await translateDoc(base({
      numPages: 1, getPage: async (n) => fakePage(n, 2),
      layoutPage: async () => ({ text: '1 | text\n2 | text', truncated: false }),
      translateGroups: async ({ groups }) => {
        calls.push(groups.map((g) => g.id));
        if (groups.length === 2) return { text: 'g1\nA\n%%', truncated: false };     // 漏 g2
        return { text: 'g2\nB\n%%', truncated: false };
      },
    }));
    expect(calls).toEqual([['g1', 'g2'], ['g2']]);
    expect(doc!.blocks.map((b) => b.target)).toEqual(['A', 'B']);
  });

  it('第二步截断 → 对半拆组，各自再发', async () => {
    const calls: string[][] = [];
    await translateDoc(base({
      numPages: 1, getPage: async (n) => fakePage(n, 4),
      layoutPage: async () => ({ text: '1 | text\n2 | text\n3 | text\n4 | text', truncated: false }),
      translateGroups: async ({ groups }) => {
        calls.push(groups.map((g) => g.id));
        if (groups.length === 4) return { text: '', truncated: true };
        return { text: groups.map((g) => `${g.id}\nT\n%%`).join('\n'), truncated: false };
      },
    }));
    expect(calls).toEqual([['g1', 'g2', 'g3', 'g4'], ['g1', 'g2'], ['g3', 'g4']]);
  });

  it('第一步失败的原因以「版面：」开头、第二步以「翻译：」开头', async () => {
    const a = await translateDoc(base({ numPages: 1, layoutPage: async () => ({ text: 'nope', truncated: false }) }));
    expect(a!.failureReasons!['1']).toMatch(/^版面：.*；重试：/);
    const b = await translateDoc(base({ numPages: 1, translateGroups: async () => ({ text: 'nope', truncated: false }) }));
    expect(b!.failureReasons!['1']).toMatch(/^翻译：.*；重试：/);
  });

  it('几何校验在第一步之后就跑：拆也救不回的组 → 该页失败，原因带「版面：」', async () => {
    // 两步之后**译文还没回来**，layout 组一个都没有 target——几何校验若仍按「有没有 target」
    // 判要不要查，整层校验就是静默死的（能编译、能全绿、盖字照发生）。这里行 1 是 30pt 的大字，
    // 行 2 的中心落在它自己的字身框里——单独一行就盖住别人，repairGroupGeometry 拆无可拆，
    // 必须在第一步之后当场被判失败。
    const tallPage = {
      getTextContent: async () => ({
        items: [
          { str: 'BIG', transform: [30, 0, 0, 30, 72, 300], width: 90, height: 30, hasEOL: true },
          { str: 'small', transform: [10, 0, 0, 10, 72, 295], width: 40, height: 10, hasEOL: true },
        ],
      }),
      getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, 400 - y] }),
    };
    const doc = await translateDoc(base({
      numPages: 1,
      getPage: async () => tallPage,
      layoutPage: async () => ({ text: '1 | text\n2 | text', truncated: false }),
    }));
    expect(doc!.blocks).toEqual([]);
    expect(doc!.failedPages).toEqual([1]);
    expect(doc!.failureReasons!['1']).toMatch(/^版面：.*盖住了不属于它的行 2/);
  });

  it('跨行盖住别人的组先拆再过校验：{1,4} 拆成 {1} 与 {4}，该页成功、块按拆后的组出（spec 2026-09-07 §8.7）', async () => {
    // 以前这一页被判失败（{1,4} 纵跨四行，行 2 / 3 的中心落进它的矩形）。拆分后四个块各占一行：
    // 第二步收到的是拆后的四组、按模型给的组序 [1]、[4]、[2]、[3]；落盘的块由 buildBlocks 按最小
    // 行号重编，所以是 1、2、3、4。
    const seen: string[][] = [];
    const doc = await translateDoc(base({
      numPages: 1,
      getPage: async (n) => fakePage(n, 4),
      layoutPage: async () => ({ text: '1,4 | text\n2 | text\n3 | text', truncated: false }),
      translateGroups: async ({ page, groups }) => {
        seen.push(groups.map((g) => g.source));
        return translateOk({ page, groups });
      },
    }));
    expect(doc!.failedPages).toBeUndefined();
    expect(seen).toEqual([['p1l1', 'p1l4', 'p1l2', 'p1l3']]);
    expect(doc!.blocks.map((b) => b.source)).toEqual(['p1l1', 'p1l2', 'p1l3', 'p1l4']);
  });
});

describe('收尾重试（pageAttempts）', () => {
  /** 第 n 次调用之前一直失败的假第二步；`calls` 记每次是哪一页。 */
  const flakyTranslate = (failUntil: number, page: number, calls: number[]) =>
    async (a: { page: number; groups: { id: string }[] }) => {
      if (a.page !== page) return translateOk(a);
      calls.push(a.page);
      return calls.length <= failUntil ? { text: 'no header', truncated: false } : translateOk(a);
    };

  it('主轮失败的页在收尾轮被救回来 → 没有失败页；不开收尾轮的话同一份夹具就是失败的', async () => {
    // 第 2 页前两次（主轮的两次机会）都坏，第三次好 —— 只有存在第二轮才可能拿到那第三次。
    const phases: string[] = [];
    const calls: number[] = [];
    const doc = await translateDoc(base({
      numPages: 2, pageAttempts: 2,
      translateGroups: flakyTranslate(2, 2, calls),
      onProgress: (p: { phase: string }) => phases.push(p.phase),
    }));
    expect(doc!.blocks.map((b) => [b.page, b.target])).toEqual([[1, 'T1'], [2, 'T2']]);
    expect(doc!.failedPages).toBeUndefined();
    expect(phases).toContain('retry');

    // 反面：同一份夹具、只把 pageAttempts 去掉（缺省 1 轮）→ 第 2 页就是失败页。
    const calls2: number[] = [];
    const once = await translateDoc(base({ numPages: 2, translateGroups: flakyTranslate(2, 2, calls2) }));
    expect(once!.failedPages).toEqual([2]);
  });

  it('收尾轮里每一步只发一次：一直失败的页，两轮共 3 次翻译、2 次版面', async () => {
    const tr: number[] = [];
    const lay: number[] = [];
    const doc = await translateDoc(base({
      numPages: 2, pageAttempts: 2,
      layoutPage: async (a: { page: number; lines: { n: number }[] }) => { lay.push(a.page); return layoutOk(a); },
      translateGroups: async (a: { page: number; groups: { id: string }[] }) => {
        if (a.page !== 2) return translateOk(a);
        tr.push(a.page);
        return { text: 'no header', truncated: false };
      },
    }));
    // 主轮 2 次（tryStep 的两次机会）+ 收尾轮 1 次。收尾轮也发 2 次的话这里就是 4。
    expect(tr).toHaveLength(3);
    // 版面：主轮一次就过，收尾轮整页重来又一次 —— 第二步失败不会让第一步在同一轮里重跑。
    expect(lay.filter((n) => n === 2)).toHaveLength(2);
    expect(doc!.failedPages).toEqual([2]);
  });

  it('pageAttempts = 3：最多三轮就收手，边车记最后一轮的原因', async () => {
    const tr: number[] = [];
    const doc = await translateDoc(base({
      numPages: 2, pageAttempts: 3,
      translateGroups: async (a: { page: number; groups: { id: string }[] }) => {
        if (a.page !== 2) return translateOk(a);
        tr.push(a.page);
        return { text: 'no header', truncated: false };
      },
    }));
    expect(tr).toHaveLength(4);                 // 2（主轮）+ 1 + 1
    expect(doc!.failedPages).toEqual([2]);
    // 最后一轮只发了一次，所以原因里没有「；重试：」那一段；主轮失败的原因才有。
    expect(doc!.failureReasons!['2']).not.toMatch(/；重试：/);
    const once = await translateDoc(base({
      numPages: 2,
      translateGroups: async (a: { page: number; groups: { id: string }[] }) =>
        (a.page === 2 ? { text: 'no header', truncated: false } : translateOk(a)),
    }));
    expect(once!.failureReasons!['2']).toMatch(/；重试：/);
  });

  it('收尾轮的进度：phase 换成 retry，分母是这一轮要重试的页数，失败数随救回来递减', async () => {
    const seen: { phase: string; done: number; total: number; failed: number }[] = [];
    const calls: number[] = [];
    await translateDoc(base({
      numPages: 3, pageAttempts: 2,
      // 第 2、3 页主轮都失败；收尾轮里第 2 页好了，第 3 页仍坏。
      translateGroups: async (a: { page: number; groups: { id: string }[] }) => {
        if (a.page === 1) return translateOk(a);
        if (a.page === 3) return { text: 'no header', truncated: false };
        calls.push(a.page);
        return calls.length <= 2 ? { text: 'no header', truncated: false } : translateOk(a);
      },
      onProgress: (p: { phase: string; done: number; total: number; failed: number }) => seen.push({ ...p }),
    }));
    const retry = seen.filter((p) => p.phase === 'retry');
    expect(retry.length).toBeGreaterThan(0);
    expect(retry[0]).toEqual({ phase: 'retry', done: 0, total: 2, failed: 2 });  // 开轮时两页都还失败着
    expect(retry.at(-1)!.failed).toBe(1);                                        // 第 2 页救回来了
    expect(retry.at(-1)!.done).toBe(2);
  });

  it('取消在轮与轮之间生效：主轮跑完就取消 → 返回 null，收尾轮一次调用都不发', async () => {
    let cancelled = false;
    const tr: number[] = [];
    const phases: string[] = [];
    const doc = await translateDoc(base({
      numPages: 2, pageAttempts: 3,
      translateGroups: async (a: { page: number; groups: { id: string }[] }) => {
        if (a.page !== 2) return translateOk(a);
        tr.push(a.page);
        return { text: 'no header', truncated: false };
      },
      isCancelled: () => cancelled,
      onProgress: (p: { phase: string; done: number; total: number }) => {
        phases.push(p.phase);
        // 主轮最后一页落地时按下取消。
        if (p.phase === 'translate' && p.done === p.total) cancelled = true;
      },
    }));
    expect(doc).toBeNull();
    expect(tr).toHaveLength(2);   // 只有主轮那两次；上一条用例证明不取消时会有第 3、第 4 次
    // 轮与轮之间那道闸：取消之后连「正在重试失败页」这一帧都不该亮 —— 池子里的检查点只挡得住
    // 派发，挡不住轮首那次 tick，用户会看见一个永远不动的重试浮层。
    expect(phases).not.toContain('retry');
    // 正向对照：不取消时同一份夹具确实会走到 retry（上面那条用例也断过）。
    const phases2: string[] = [];
    await translateDoc(base({
      numPages: 2, pageAttempts: 3,
      translateGroups: async (a: { page: number; groups: { id: string }[] }) =>
        (a.page === 2 ? { text: 'no header', truncated: false } : translateOk(a)),
      onProgress: (p: { phase: string }) => phases2.push(p.phase),
    }));
    expect(phases2).toContain('retry');
  });

  it('「重试失败页」那条路：部分跑 + 三轮，第三次成的页从边车的 failedPages 里消失', async () => {
    const BASE2: TranslatedDoc = {
      version: 1, pdf: 'p.pdf', lang: { in: 'auto', out: 'zh' },
      source: { sha256: 'old', bytes: 1 },
      failedPages: [2], failureReasons: { '2': '上一趟失败了' },
      blocks: [{ id: 'p1-b01', page: 1, x: 72, y: 100, width: 40, height: 10, fontSize: 10, kind: 'text', source: 'p1l1', target: 'T1' }],
    };
    const calls: number[] = [];
    const doc = await translateDoc(base({
      numPages: 2, pages: [2], base: BASE2, pageAttempts: 3,
      translateGroups: flakyTranslate(3, 2, calls),   // 前三次坏（主轮 2 次 + 第二轮 1 次），第四次好
    }));
    expect(calls).toHaveLength(4);
    expect(doc!.blocks.map((b) => b.page)).toEqual([1, 2]);
    expect(doc!.failedPages).toBeUndefined();
    expect('failureReasons' in doc!).toBe(false);
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
      layoutPage: async (a) => { translated.push(a.page); return layoutOk(a); },
      onProgress: (p) => { if (p.phase === 'extract') extracts.push(p.total); },
    }));
    expect(got).toEqual([2, 3]);
    expect(translated.sort()).toEqual([2, 3]);
    expect(new Set(extracts)).toEqual(new Set([2]));
  });

  it('合并：pages 之外的块逐字不变，failedPages / failureReasons 先删再并，source 是当前摘要', async () => {
    const doc = await translateDoc(base({
      numPages: 4, pages: [2, 3], base: BASE, glossary: BASE.glossary,
      translateGroups: async ({ page }) => ({
        text: page === 3 ? 'no header' : 'g1\nNEW\n%%', truncated: false,   // 3 两次都失败
      }),
    }));
    expect(doc!.blocks.map((b) => b.id)).toEqual(['p1-b01', 'p2-b01', 'p4-b01']);
    expect(doc!.blocks[0]).toEqual(BASE.blocks[0]);
    expect(doc!.blocks[2]).toEqual(BASE.blocks[1]);
    expect(doc!.blocks[1].target).toBe('NEW');
    expect(doc!.failedPages).toEqual([3]);
    expect(doc!.failureReasons).toEqual({ '3': expect.stringMatching(/^翻译：组头不是 id/) });
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
      layoutPage: async (a) => { titles.push(a.docTitle); return layoutOk(a); },
      translateGroups: async (a) => { titles.push(a.docTitle); return translateOk(a); },
    }));
    expect(titles).toEqual(['My Title', 'My Title']);
  });

  it('给了 pages 没给 base → 抛', async () => {
    await expect(translateDoc(base({ numPages: 4, pages: [2] }))).rejects.toThrow('pages 需要 base');
  });

  it('pages 里全是零行页（纯图页上点「重译本页」）→ 不发请求，底本原样返回、只盖上当前摘要', async () => {
    const layoutPage = vi.fn();
    const doc = await translateDoc(base({
      numPages: 4, pages: [2], base: BASE, layoutPage,
      getPage: async () => ({ getTextContent: async () => ({ items: [] }), getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, y] }) }),
    }));
    expect(layoutPage).not.toHaveBeenCalled();
    expect(doc!.blocks).toEqual(BASE.blocks);
    expect(doc!.failedPages).toEqual(BASE.failedPages);
    expect(doc!.source).toEqual({ sha256: 'ab', bytes: 1 });
  });
});

describe('脚标占位符（spec 2026-09-07 scripts §3.2 / §5.2）', () => {
  // 一行 "node n" + 小字号、基线更低的 "i" → 行文本 "node ni"，scripts [{6,7,sub}]
  const scriptPage = (extraLines = 0) => ({
    getTextContent: async () => ({
      items: [
        { str: 'node n', transform: [10, 0, 0, 10, 72, 300], width: 30, height: 10, hasEOL: false },
        { str: 'i', transform: [7, 0, 0, 7, 102, 298.5], width: 3, height: 7, hasEOL: true },
        ...Array.from({ length: extraLines }, (_, k) => ({
          str: `plain ${k + 1}`, transform: [10, 0, 0, 10, 72, 280 - k * 14], width: 40, height: 10, hasEOL: true,
        })),
      ],
    }),
    getViewport: () => ({ convertToViewportPoint: (x: number, y: number) => [x, 400 - y] }),
  });

  it('第二步收到记号化的 source；边车 source 是明文、placeholders 带 script、target 带记号', async () => {
    const got: unknown[] = [];
    const doc = await translateDoc(base({
      numPages: 1, getPage: async () => scriptPage(),
      layoutPage: async () => ({ text: '1 | text', truncated: false }),
      translateGroups: async ({ groups }) => { got.push(groups); return { text: 'g1\n节点 n{v1}\n%%', truncated: false }; },
    }));
    expect(got).toEqual([[{ id: 'g1', kind: 'text', source: 'node n{v1}' }]]);
    expect(doc!.blocks[0]).toMatchObject({
      source: 'node ni', target: '节点 n{v1}',
      placeholders: [{ id: 'v1', kind: 'formula', text: 'i', script: 'sub' }],
    });
  });

  it('两组里只有一组丢记号 → 只把那一组再发一次并合并，页不判失败', async () => {
    const calls: string[][] = [];
    const translateGroups = vi.fn(async ({ groups }: { groups: { id: string }[] }) => {
      calls.push(groups.map((g) => g.id));
      return calls.length === 1
        ? { text: 'g1\n节点 n\n%%\ng2\n平的 1\n%%', truncated: false }   // g1 丢了 {v1}
        : { text: 'g1\n节点 n{v1}\n%%', truncated: false };
    });
    const doc = await translateDoc(base({
      numPages: 1, getPage: async () => scriptPage(1),
      layoutPage: async () => ({ text: '1 | text\n2 | text', truncated: false }),
      translateGroups,
    }));
    expect(calls).toEqual([['g1', 'g2'], ['g1']]);
    expect(doc!.failedPages).toBeUndefined();
    expect(doc!.blocks.map((b) => b.target)).toEqual(['节点 n{v1}', '平的 1']);
  });

  it('违约的就是全部 → 整步重试；两次都丢 → 页失败，原因含「记号」与丢的 id', async () => {
    const translateGroups = vi.fn(async () => ({ text: 'g1\n节点 n\n%%', truncated: false }));
    const doc = await translateDoc(base({
      numPages: 1, getPage: async () => scriptPage(),
      layoutPage: async () => ({ text: '1 | text', truncated: false }),
      translateGroups,
    }));
    expect(translateGroups).toHaveBeenCalledTimes(2);
    expect(doc!.blocks).toEqual([]);
    expect(doc!.failedPages).toEqual([1]);
    expect(doc!.failureReasons!['1']).toMatch(/^翻译：组 g1 的译文记号不对（g1: 丢 v1）；重试：/);
  });

  it('译文多出原文没有的记号 → 同样违约重发', async () => {
    const translateGroups = vi.fn(async () => ({ text: 'g1\n节点 n{v1} 与 m{v7}\n%%', truncated: false }));
    const doc = await translateDoc(base({
      numPages: 1, getPage: async () => scriptPage(),
      layoutPage: async () => ({ text: '1 | text', truncated: false }),
      translateGroups,
    }));
    expect(translateGroups).toHaveBeenCalledTimes(2);
    expect(doc!.failureReasons!['1']).toMatch(/多出 v7/);
  });

  it('没有脚标的页：请求串、调用序列与今天相同', async () => {
    const got: unknown[] = [];
    await translateDoc(base({
      numPages: 1, getPage: async (n) => fakePage(n, 2),
      layoutPage: async () => ({ text: '1-2 | text', truncated: false }),
      translateGroups: async ({ groups }) => { got.push(groups); return { text: 'g1\nA\n%%', truncated: false }; },
    }));
    expect(got).toEqual([[{ id: 'g1', kind: 'text', source: 'p1l1 p1l2' }]]);
  });

  it('docTitle 是去记号的明文，不是发给模型的记号串', async () => {
    const gotTitles: (string | undefined)[] = [];
    await translateDoc(base({
      numPages: 1, getPage: async () => scriptPage(),
      layoutPage: async () => ({ text: '1 | title', truncated: false }),
      translateGroups: async ({ groups, docTitle }) => {
        gotTitles.push(docTitle);
        return { text: `${groups[0].id}\n节点 n{v1}\n%%`, truncated: false };
      },
    }));
    // 第 1 页本身也走了这次翻译（它是唯一一页），传给它的 docTitle 就是它自己的标题——
    // 断言的是「明文」这一点：不能是 'node n{v1}'。
    expect(gotTitles).toEqual(['node ni']);
  });

  it('多行组、行号非升序：请求串与边车 source 出自同一批行、同一顺序（漂移会让记号错位）', async () => {
    const got: { id: string; source: string }[][] = [];
    const doc = await translateDoc(base({
      numPages: 1, getPage: async () => scriptPage(1),
      // 组内行号顺序 [2, 1]，与升序相反——drift 一旦发生（两处排序不一致），下面的还原断言就会不等。
      layoutPage: async () => ({ text: '2,1 | text', truncated: false }),
      translateGroups: async ({ groups }) => { got.push(groups); return { text: 'g1\n译文{v1}\n%%', truncated: false }; },
    }));
    const reqSource = got[0][0].source;
    const block = doc!.blocks[0];
    // 把请求串里的每个 {vN} 用边车 placeholders 换回原文，结果必须逐字等于边车块的 source——
    // 这正是「两处对同一批行、同一顺序调 tokenize」这条不变量本身。
    const restored = reqSource.replace(/\{(v\d+)\}/g, (m, id: string) => {
      const p = block.placeholders?.find((ph) => ph.id === id);
      return p ? p.text : m;
    });
    expect(restored).toBe(block.source);
  });
});
