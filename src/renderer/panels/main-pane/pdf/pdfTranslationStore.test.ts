import { describe, expect, it, beforeEach } from 'vitest';
import { checkVersion, usePdfTranslationStore } from './pdfTranslationStore';
import type { TranslatedDoc } from '../../../../shared/zhSidecar';

const doc = (source?: { sha256: string; bytes: number }): TranslatedDoc => ({
  version: 1, pdf: 'p.pdf', lang: { in: 'en', out: 'zh' }, source, blocks: [],
});

describe('checkVersion', () => {
  it('没写 source → unknown（可用但提示）', () => {
    expect(checkVersion(doc(), 'aa', 10)).toBe('unknown');
  });
  it('摘要与字节数都对得上 → ok', () => {
    expect(checkVersion(doc({ sha256: 'aa', bytes: 10 }), 'aa', 10)).toBe('ok');
  });
  it('摘要对不上 → mismatch', () => {
    expect(checkVersion(doc({ sha256: 'bb', bytes: 10 }), 'aa', 10)).toBe('mismatch');
  });
  it('字节数对不上也算 mismatch —— 摘要相同而长度不同只可能是写错了', () => {
    expect(checkVersion(doc({ sha256: 'aa', bytes: 11 }), 'aa', 10)).toBe('mismatch');
  });
  it('摘要大小写不敏感', () => {
    expect(checkVersion(doc({ sha256: 'AA', bytes: 10 }), 'aa', 10)).toBe('ok');
  });
});

// setLoaded 是 loadTranslation 的唯一写入方：首次加载、sizes 到位后的几何重过滤、每次窗口
// focus 的重探（spec §3.4）都走它。dual 的维持/收掉必须由它来判——不能只靠 annotationKeys.ts
// 里 L 键的入口闸，那道闸只挡「进」，挡不住「已经在对照里、bucket 后来变了」。
describe('usePdfTranslationStore.setLoaded 维持 dual', () => {
  const T = '/p/paper.pdf';
  const ZH: TranslatedDoc = {
    version: 1, pdf: 'p.pdf', lang: { in: 'en', out: 'zh' },
    source: { sha256: 'aa', bytes: 10 }, blocks: [],
  };
  const st = () => usePdfTranslationStore.getState();

  beforeEach(() => {
    usePdfTranslationStore.setState({ buckets: {} });
  });

  it('对照中 version 变 mismatch → dual 自动退出', () => {
    st().setLoaded(T, ZH, 'ok', 0);
    st().setDual(T, true);
    expect(st().buckets[T].dual).toBe(true);
    st().setLoaded(T, ZH, 'mismatch', 0);
    expect(st().buckets[T].dual).toBe(false);
  });

  it('对照中 doc 变 null（边车被删）→ dual 自动退出', () => {
    st().setLoaded(T, ZH, 'ok', 0);
    st().setDual(T, true);
    expect(st().buckets[T].dual).toBe(true);
    st().setLoaded(T, null, 'unknown', 0);
    expect(st().buckets[T].dual).toBe(false);
  });

  it('version 仍是 ok 时 dual 保持不变（每次 focus 重探不能把用户踢出对照）', () => {
    st().setLoaded(T, ZH, 'ok', 0);
    st().setDual(T, true);
    st().setLoaded(T, ZH, 'ok', 2);
    expect(st().buckets[T].dual).toBe(true);
    st().setLoaded(T, ZH, 'ok', 3);
    expect(st().buckets[T].dual).toBe(true);
  });
});

// prevScale 的语义是「一份**还没被消费**的还原请求」，不是「进对照时的快照」：谁把 dual 收掉
// 都行，`dual === false && prevScale !== null` 这个瞬态由渲染层看见、还原缩放、再 clearPrevScale
// （PdfFileTab 里那个 effect）。收 dual 的路径有两条——显式退出，和 setLoaded 撞见边车没了 /
// 摘要对不上时的自动退出。setDual 若在退出时把 prevScale 清成 null，自动退出那条路就永远没有
// 还原请求可消费，用户被踢出对照后停在双栏 fit-width 的小缩放上。
describe('usePdfTranslationStore 的 prevScale 是一份待消费的还原请求', () => {
  const T = '/p/paper.pdf';
  const ZH: TranslatedDoc = {
    version: 1, pdf: 'p.pdf', lang: { in: 'en', out: 'zh' },
    source: { sha256: 'aa', bytes: 10 }, blocks: [],
  };
  const st = () => usePdfTranslationStore.getState();

  beforeEach(() => {
    usePdfTranslationStore.setState({ buckets: {} });
  });

  it('显式退出：dual 收掉，prevScale 留着等人还原', () => {
    st().setLoaded(T, ZH, 'ok', 0);
    st().setDual(T, true, 0.5);
    st().setDual(T, false);
    expect(st().buckets[T].dual).toBe(false);
    expect(st().buckets[T].prevScale).toBe(0.5);
  });

  it('自动退出（setLoaded 撞见 mismatch）：prevScale 同样留着，还原走同一条路径', () => {
    st().setLoaded(T, ZH, 'ok', 0);
    st().setDual(T, true, 0.5);
    st().setLoaded(T, ZH, 'mismatch', 0);
    expect(st().buckets[T].dual).toBe(false);
    expect(st().buckets[T].prevScale).toBe(0.5);
  });

  it('自动退出（边车被删）：prevScale 同样留着', () => {
    st().setLoaded(T, ZH, 'ok', 0);
    st().setDual(T, true, 0.5);
    st().setLoaded(T, null, 'unknown', 0);
    expect(st().buckets[T].dual).toBe(false);
    expect(st().buckets[T].prevScale).toBe(0.5);
  });

  it('消费之后 dual=false 且 prevScale≠null 不再成立', () => {
    st().setLoaded(T, ZH, 'ok', 0);
    st().setDual(T, true, 0.5);
    st().setDual(T, false);
    st().clearPrevScale(T);
    expect(st().buckets[T].prevScale).toBeNull();
  });

  it('进对照时行宽本来就放得下 → 没有还原请求', () => {
    st().setLoaded(T, ZH, 'ok', 0);
    st().setDual(T, true, null);
    st().setDual(T, false);
    expect(st().buckets[T].prevScale).toBeNull();
  });

  it('clearPrevScale 对不存在的桶是 no-op，不会凭空造一个桶出来', () => {
    st().clearPrevScale('/p/never-opened.pdf');
    expect(st().buckets['/p/never-opened.pdf']).toBeUndefined();
  });
});
