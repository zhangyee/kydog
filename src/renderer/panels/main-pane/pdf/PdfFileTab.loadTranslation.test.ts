import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TranslatedDoc } from '../../../../shared/zhSidecar';
import { loadTranslationSidecar, releaseTranslationBucket } from './PdfFileTab';
import { usePdfTranslationStore } from './pdfTranslationStore';

/**
 * 译文边车的加载与关 tab 释放（原先由 e2e/57「关 tab 之后，在途的译文加载不会把桶重建回来」
 * 在真应用里数 `__kydogTranslationBuckets` 守着）。
 *
 * 那条 e2e 的做法是同一拍里先发 focus（触发重探，RPC 在途）、再点关闭。这里把 RPC 换成一个
 * 手动放行的 promise，次序就是确定的：发起 → 关 tab → 放行，不靠抢时间窗口。
 *
 * 守不住的：组件卸载时**真的调了** releaseTranslationBucket（PdfFileTab 在 node 里挂不起来）。
 * 这里钉的是「调了之后在途那趟不会把桶重建回来」。
 */

const T = '/proj/paper.pdf';
const st = () => usePdfTranslationStore.getState();

const SHA = 'ab'.repeat(32);
const BYTES = new Uint8Array(4);

/** 摘要对得上 BYTES / SHA 的那份 source。不写成默认参数：传 undefined 会撞上默认值，「没写 source」就测不到了。 */
const SOURCE = { sha256: SHA, bytes: BYTES.byteLength };
function zh(blocks: TranslatedDoc['blocks'], source: TranslatedDoc['source']): TranslatedDoc {
  return { version: 1, pdf: 'paper.pdf', lang: { in: 'en', out: 'zh' }, source, blocks };
}
const OK_BLOCK = { id: 'ok1', page: 1, x: 60, y: 200, width: 460, height: 120, fontSize: 11, kind: 'text' as const, source: 'a', target: '甲' };
const DOC = zh([OK_BLOCK], SOURCE);

/** 每一次 `pdf.translation.load` 都挂在这里，由用例手动放行。 */
type Pending = { pdfPath: string; resolve: (v: { doc: TranslatedDoc | null }) => void; reject: (e: Error) => void };
const pending: Pending[] = [];

const args = (sizes: { w: number; h: number }[] | null = null) => ({ tabId: T, pdfPath: T, bytes: BYTES, sha: SHA, sizes });

beforeEach(() => {
  pending.length = 0;
  usePdfTranslationStore.setState({ buckets: {} });
  (globalThis as unknown as { window: unknown }).window = {
    kydog: {
      invoke: (method: string, a: { pdfPath: string }) => {
        if (method !== 'pdf.translation.load') return Promise.reject(new Error(`意外的 RPC：${method}`));
        return new Promise((resolve, reject) => { pending.push({ pdfPath: a.pdfPath, resolve, reject }); });
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).window;
});

describe('关 tab 之后，在途的译文加载不会把桶重建回来（e2e/57）', () => {
  it('成功分支：先建得起桶；裸 drop 挡不住在途那趟；releaseTranslationBucket 挡得住', async () => {
    const seq = { current: 0 };

    // ① 打开 PDF：第一趟落地，桶建起来——查找与写入这条路本身是通的。
    const first = loadTranslationSidecar(seq, args());
    expect(pending.map((p) => p.pdfPath)).toEqual([T]);
    pending[0].resolve({ doc: DOC });
    await first;
    expect(Object.keys(st().buckets)).toEqual([T]);
    expect(st().buckets[T].doc?.blocks.map((b) => b.id)).toEqual(['ok1']);

    // ② 对照：窗口 focus 触发重探（在途），这时只做一次裸 drop、不推代号——在途那趟落地会把
    //    桶原地重建回来。这一步证明下面要挡的那个危险是真的，不是 store 自己就不会重建。
    const second = loadTranslationSidecar(seq, args());
    st().drop(T);
    expect(st().buckets[T]).toBeUndefined();
    pending[1].resolve({ doc: DOC });
    await second;
    expect(Object.keys(st().buckets)).toEqual([T]);

    // ③ 本体：又一趟重探在途，这回走关 tab 真正调的那个释放函数。
    const third = loadTranslationSidecar(seq, args());
    releaseTranslationBucket(seq, T);
    expect(st().buckets[T]).toBeUndefined();
    pending[2].resolve({ doc: DOC });
    await third;
    expect(Object.keys(st().buckets)).toEqual([]);
  });

  it('失败分支同理：关 tab 之后在途那趟以错误落地，也不靠 setLoadError 把桶建回来', async () => {
    const seq = { current: 0 };

    // 对照：没关 tab 时，失败落地确实会建桶、写上 loadError。
    const first = loadTranslationSidecar(seq, args());
    pending[0].reject(new Error('Unexpected token b in JSON'));
    await first;
    expect(st().buckets[T]?.loadError).toBe('Unexpected token b in JSON');

    const second = loadTranslationSidecar(seq, args());
    releaseTranslationBucket(seq, T);
    expect(st().buckets[T]).toBeUndefined();
    pending[1].reject(new Error('Unexpected token b in JSON'));
    await second;
    expect(Object.keys(st().buckets)).toEqual([]);
  });
});

/**
 * e2e/57「Notice——几何越界丢块、没写源摘要」那两份 fixture 的**上游半截**：边车落进桶里时，
 * 丢块计数与版本态是不是真的从这里写进去的。下游半截（桶 → Notice 文案 / 翻译键可按）在
 * PdfAnnotationNotice.test.ts 与 PdfToolbar.test.tsx。
 */
describe('边车 → 译文桶：丢块计数与版本态', () => {
  const PAGE = [{ w: 595, h: 842 }];

  it('一条块 y 越出页底 → 被滤掉、dropped = 1；摘要对得上 → version ok', async () => {
    const seq = { current: 0 };
    const p = loadTranslationSidecar(seq, args(PAGE));
    pending[0].resolve({ doc: zh([OK_BLOCK, { ...OK_BLOCK, id: 'bad1', y: 900 }], SOURCE) });
    await p;
    const b = st().buckets[T];
    expect(b.dropped).toBe(1);
    expect(b.doc?.blocks.map((x) => x.id)).toEqual(['ok1']);
    expect(b.version).toBe('ok');
  });

  it('边车没写 source → version unknown；没有越界块 → dropped = 0', async () => {
    const seq = { current: 0 };
    const p = loadTranslationSidecar(seq, args(PAGE));
    pending[0].resolve({ doc: zh([OK_BLOCK], undefined) });
    await p;
    const b = st().buckets[T];
    expect(b.version).toBe('unknown');
    expect(b.dropped).toBe(0);
    expect(b.doc?.blocks.map((x) => x.id)).toEqual(['ok1']);
  });
});
