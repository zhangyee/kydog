import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSaveScheduler, watchDocs } from './saveScheduler';
import { usePdfAnnotationStore } from './pdfAnnotationStore';
import type { Highlight, PdfAnnotationsFile } from '../../../../shared/pdfSidecar';

const T = '/p/paper.pdf';
const EMPTY: PdfAnnotationsFile = { version: 1, pdf: 'paper.pdf', annotations: [] };
const H = (id: string): Highlight => ({ id, type: 'highlight', page: 1, color: 'amber', width: 2,
  segments: [{ kind: 'path', points: [[0, 0], [9, 9]] }], createdAt: 'now' });
const st = () => usePdfAnnotationStore.getState();

describe('saveScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    usePdfAnnotationStore.setState({ buckets: {} });
    st().setLoaded(T, EMPTY);
  });

  it('300 ms 内多次 schedule 只写一次，写的是最新 doc', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const sch = createSaveScheduler(save);
    st().addHighlight(T, H('a')); sch.schedule(T);
    st().addHighlight(T, H('b')); sch.schedule(T);
    await vi.advanceTimersByTimeAsync(299);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][1].annotations.map((a: Highlight) => a.id)).toEqual(['a', 'b']);
  });

  it('在途期间的改动在完成后补写一次', async () => {
    let release: () => void = () => {};
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => { release = r; })).mockResolvedValue(undefined);
    const sch = createSaveScheduler(save);
    st().addHighlight(T, H('a')); sch.schedule(T);
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledTimes(1);
    st().addHighlight(T, H('b')); sch.schedule(T);
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledTimes(1);          // 还在飞，不并发
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1].annotations).toHaveLength(2);
  });

  it('失败记 saveError 且 doc 不变；下次成功后清空', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('磁盘满')).mockResolvedValue(undefined);
    const sch = createSaveScheduler(save);
    st().addHighlight(T, H('a')); sch.schedule(T);
    await vi.advanceTimersByTimeAsync(300);
    expect(st().buckets[T].saveError).toBe('磁盘满');
    expect(st().buckets[T].doc?.annotations).toHaveLength(1);
    sch.schedule(T);
    await vi.advanceTimersByTimeAsync(300);
    expect(st().buckets[T].saveError).toBeNull();
  });

  it('flush 立即写并清掉定时器', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const sch = createSaveScheduler(save);
    st().addHighlight(T, H('a')); sch.schedule(T);
    await sch.flush(T);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flush 后立刻 drop 桶，在途与排队的两份都仍然写出去', async () => {
    let release: () => void = () => {};
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => { release = r; })).mockResolvedValue(undefined);
    const sch = createSaveScheduler(save);
    st().addHighlight(T, H('a')); sch.schedule(T);
    await vi.advanceTimersByTimeAsync(300);          // 第一份在飞
    st().addHighlight(T, H('b'));
    void sch.flush(T);                                // 第二份排队
    st().drop(T);                                     // 关 tab
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1].annotations.map((a: Highlight) => a.id)).toEqual(['a', 'b']);
    expect(st().buckets[T]).toBeUndefined();          // 迟到的结果没把桶造回来
  });

  it('loadError 的桶不写；未加载的桶不写', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const sch = createSaveScheduler(save);
    st().setLoadError(T, '坏了');
    await sch.flush(T);
    await sch.flush('/p/never-loaded.pdf');
    expect(save).not.toHaveBeenCalled();
  });

  it('watchDocs：setLoaded 不触发，改 doc 触发', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const sch = createSaveScheduler(save);
    const stop = watchDocs(sch);
    st().setLoaded('/p/b.pdf', EMPTY);
    await vi.advanceTimersByTimeAsync(300);
    expect(save).not.toHaveBeenCalled();
    st().addHighlight(T, H('a'));
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenCalledWith(T, expect.objectContaining({ annotations: [expect.objectContaining({ id: 'a' })] }));
    stop();
  });
});
