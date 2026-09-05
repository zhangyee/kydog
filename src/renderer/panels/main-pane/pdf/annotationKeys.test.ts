import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleAnnotationKey } from './annotationKeys';
import { usePdfAnnotationStore } from './pdfAnnotationStore';
import { usePdfTranslationStore } from './pdfTranslationStore';
import type { Highlight, PdfAnnotationsFile } from '../../../../shared/pdfSidecar';
import type { TranslatedDoc } from '../../../../shared/zhSidecar';

const T = '/p/paper.pdf';
const EMPTY: PdfAnnotationsFile = { version: 1, pdf: 'paper.pdf', annotations: [] };
const H: Highlight = { id: 'h1', type: 'highlight', page: 1, color: 'amber', width: 2,
  segments: [{ kind: 'path', points: [[0, 0], [9, 9]] }], createdAt: 'now' };
const st = () => usePdfAnnotationStore.getState();
const key = (
  k: string,
  extra: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; target: unknown }> = {},
) => ({ key: k, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: null, preventDefault() {}, ...extra });

const ZH: TranslatedDoc = {
  version: 1, pdf: 'paper.pdf', lang: { in: 'en', out: 'zh' },
  blocks: [{ id: 'b1', page: 1, x: 0, y: 0, width: 10, height: 10, fontSize: 10, kind: 'text', source: 'a', target: '甲' }],
};
const tst = () => usePdfTranslationStore.getState();

describe('handleAnnotationKey', () => {
  beforeEach(() => {
    usePdfAnnotationStore.setState({ buckets: {} });
    usePdfTranslationStore.setState({ buckets: {} });
    st().setLoaded(T, EMPTY);
  });

  it('V / H / T 切工具', () => {
    expect(handleAnnotationKey(key('h'), T)).toBe(true);
    expect(st().buckets[T].tool).toBe('highlight');
    handleAnnotationKey(key('T'), T);
    expect(st().buckets[T].tool).toBe('note');
    handleAnnotationKey(key('v'), T);
    expect(st().buckets[T].tool).toBe('select');
  });

  it('⌘Z 撤销、⇧⌘Z 重做；Ctrl 同样算', () => {
    st().addHighlight(T, H);
    expect(handleAnnotationKey(key('z', { metaKey: true }), T)).toBe(true);
    expect(st().buckets[T].doc?.annotations).toEqual([]);
    handleAnnotationKey(key('z', { ctrlKey: true, shiftKey: true }), T);
    expect(st().buckets[T].doc?.annotations).toHaveLength(1);
  });

  it('Delete / Backspace 删选中项；没选中不处理', () => {
    expect(handleAnnotationKey(key('Delete'), T)).toBe(false);
    st().addHighlight(T, H);
    st().select(T, 'h1');
    expect(handleAnnotationKey(key('Backspace'), T)).toBe(true);
    expect(st().buckets[T].doc?.annotations).toEqual([]);
  });

  it('焦点在 textarea 里：字母键不处理，Esc 先 blur 再回到选择并取消选中', () => {
    const blur = vi.fn();
    const ta = { tagName: 'TEXTAREA', blur };
    st().setTool(T, 'note');
    st().addHighlight(T, H);
    st().select(T, 'h1');
    expect(handleAnnotationKey(key('h', { target: ta }), T)).toBe(false);
    expect(handleAnnotationKey(key('Delete', { target: ta }), T)).toBe(false);
    expect(handleAnnotationKey(key('Escape', { target: ta }), T)).toBe(true);
    expect(blur).toHaveBeenCalled();
    expect(st().buckets[T]).toMatchObject({ tool: 'select', selectedId: null });
  });

  it('未加载或 loadError 时全部不处理', () => {
    st().setLoadError(T, '坏了');
    expect(handleAnnotationKey(key('h'), T)).toBe(false);
    expect(handleAnnotationKey(key('h'), '/p/other.pdf')).toBe(false);
  });

  // L 分支本身只判「该不该放行」（canPressTranslate，与 PdfToolbar 状态渲染共用同一份判据），
  // 真正进 / 出对照与 fit-width 是 PdfFileTab 传入的 onToggleDual 回调的事——那部分要读滚动容器
  // 的 DOM 宽度，这个仓库的 vitest 是 environment: 'node'（无 jsdom），组件级渲染测试不可行
  // （同 PdfFileTab.tsx 顶部关于 prefetchPageSizes 抽成纯函数的注释）。这里只能验证「回调有没
  // 有被调用、调用了几次」，进出对照本身的行为交给 e2e（57-pdf-dual-pane.spec.ts）。
  it('L 触发 onToggleDual，且不动标注工具（它是视图模式不是工具）', () => {
    tst().setLoaded(T, ZH, 'ok', 0);
    tst().setLayoutReady(T, true);   // 页尺寸没预取完时进不了对照（fit-width 要用第一页的宽）
    st().setTool(T, 'highlight');
    const onToggleDual = vi.fn();
    expect(handleAnnotationKey(key('l'), T, onToggleDual)).toBe(true);
    expect(onToggleDual).toHaveBeenCalledTimes(1);
    expect(st().buckets[T].tool).toBe('highlight');
    expect(handleAnnotationKey(key('L'), T, onToggleDual)).toBe(true);
    expect(onToggleDual).toHaveBeenCalledTimes(2);
  });

  // 二期起，没有译文 / 边车结构有误 / 摘要不匹配这三态从禁用变成可点——动作变成「跑翻译
  // 流水线」，L 因此也放行（canPressTranslate 不再排除它们）。真正跑不跑流水线是 onToggleDual
  // 回调内部的事（PdfFileTab，Task 13），这里只验证判据本身对这三态放行、调用了回调。
  it('没译文 / 边车有误 / 摘要对不上：二期这三态都放行，L 触发 onToggleDual', () => {
    const onToggleDual = vi.fn();
    tst().setLayoutReady(T, true);   // 页尺寸没到时 pending 压过这三态，先让它到位
    expect(handleAnnotationKey(key('l'), T, onToggleDual)).toBe(true);      // 边车不存在（none）
    tst().setLoadError(T, '坏了');
    expect(handleAnnotationKey(key('l'), T, onToggleDual)).toBe(true);      // 边车结构有误（invalid）
    tst().setLoaded(T, ZH, 'mismatch', 0);
    expect(handleAnnotationKey(key('l'), T, onToggleDual)).toBe(true);      // 摘要对不上（mismatch）
    expect(onToggleDual).toHaveBeenCalledTimes(3);
  });

  it('页尺寸没到 / 正在跑翻译 / ⌘L / ⌥L / 焦点在 textarea 里：L 都不处理，也不调用 onToggleDual', () => {
    const onToggleDual = vi.fn();
    tst().setLoaded(T, ZH, 'ok', 0);
    // 译文没问题，但页尺寸还没预取完：进对照要用第一页的宽度算 fit-width，这时按 L 只会静默
    // 无事发生——判据必须与工具栏那颗键一致（都走 canPressTranslate），不能一处能进一处不能进。
    expect(handleAnnotationKey(key('l'), T, onToggleDual)).toBe(false);
    tst().setLayoutReady(T, true);
    // 正在跑翻译作业：dual 恒为 true，但仍不放行——避免一次点击打断正在跑的流水线。
    tst().setJob(T, { phase: 'extract', done: 0, total: 3, failed: 0 });
    expect(handleAnnotationKey(key('l'), T, onToggleDual)).toBe(false);
    tst().setJob(T, null);
    expect(handleAnnotationKey(key('l', { metaKey: true }), T, onToggleDual)).toBe(false);
    expect(handleAnnotationKey(key('l', { altKey: true }), T, onToggleDual)).toBe(false);
    expect(handleAnnotationKey(key('l', { target: { tagName: 'TEXTAREA' } }), T, onToggleDual)).toBe(false);
    expect(onToggleDual).not.toHaveBeenCalled();
  });

  it('标注边车坏了照样能按 L —— 译文视图不该受标注加载状态牵连', () => {
    st().setLoadError(T, '坏了');
    tst().setLoaded(T, ZH, 'ok', 0);
    tst().setLayoutReady(T, true);
    const onToggleDual = vi.fn();
    expect(handleAnnotationKey(key('l'), T, onToggleDual)).toBe(true);
    expect(onToggleDual).toHaveBeenCalledTimes(1);
  });
});
