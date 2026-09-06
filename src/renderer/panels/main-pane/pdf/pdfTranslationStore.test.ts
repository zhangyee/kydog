import { describe, expect, it, beforeEach } from 'vitest';
import { canPressTranslate, checkVersion, emptyTBucket, translateUiState, usePdfTranslationStore, type TBucket } from './pdfTranslationStore';
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

// 进对照要读第一页的宽度算 fit-width，页尺寸没预取完就只能静默不动。原先这条不在判据里：
// 翻译键在预取期间是 enabled 的，按下去什么都不发生、也没有反馈（大文档预取几百页时这段窗口
// 不短）。判据必须由 translateUiState 这一份出——工具栏与 `L` 键共用它。
describe('translateUiState 的 pending 态', () => {
  const b = (over: Partial<TBucket> = {}): TBucket => ({ ...emptyTBucket(), ...over });
  const ZH: TranslatedDoc = {
    version: 1, pdf: 'p.pdf', lang: { in: 'en', out: 'zh' },
    source: { sha256: 'aa', bytes: 10 }, blocks: [],
  };

  it('译文可用但页尺寸还没到 → pending，且不放行', () => {
    const bucket = b({ doc: ZH, version: 'ok', layoutReady: false });
    expect(translateUiState(bucket)).toBe('pending');
    expect(canPressTranslate(bucket)).toBe(false);
  });

  it('页尺寸到位 → ready，放行', () => {
    const bucket = b({ doc: ZH, version: 'ok', layoutReady: true });
    expect(translateUiState(bucket)).toBe('ready');
    expect(canPressTranslate(bucket)).toBe(true);
  });

  // 二期反转：pending 现在排在 invalid/none/mismatch 之前（那三条都通向「跑流水线」，需要
  // 页尺寸算 fit-width）。完整的顺序断言在下面 `translateUiState 的新顺序` 里，这里不重复。

  it('setLayoutReady 写的就是这一维，且能收回去（换文件时 sizes 归 null）', () => {
    const T = '/p/paper.pdf';
    usePdfTranslationStore.setState({ buckets: {} });
    const st = () => usePdfTranslationStore.getState();
    st().setLoaded(T, ZH, 'ok', 0);
    expect(canPressTranslate(st().buckets[T])).toBe(false);
    st().setLayoutReady(T, true);
    expect(canPressTranslate(st().buckets[T])).toBe(true);
    st().setLayoutReady(T, false);
    expect(canPressTranslate(st().buckets[T])).toBe(false);
  });
});

const B = (o: Partial<TBucket>): TBucket => ({ ...emptyTBucket(), layoutReady: true, ...o });
const zhDoc: TranslatedDoc = { version: 1, pdf: 'p', lang: { in: 'auto', out: 'zh' }, blocks: [] };

describe('translateUiState 的新顺序', () => {
  it('translating 压过一切，包括 active', () => {
    expect(translateUiState(B({ doc: zhDoc, dual: true, job: { phase: 'translate', done: 1, total: 9, failed: 0 } })))
      .toBe('translating');
  });
  it('translating 也压过 pending：作业跑起来时页尺寸必然已经到位，但顺序不能反', () => {
    expect(translateUiState(B({ layoutReady: false, job: { phase: 'extract', done: 0, total: 3, failed: 0 } })))
      .toBe('translating');
  });
  it('pending 排在 invalid / none / mismatch 之前——它们现在都通向一个要页尺寸的动作', () => {
    expect(translateUiState(B({ layoutReady: false }))).toBe('pending');
    expect(translateUiState(B({ layoutReady: false, loadError: 'x' }))).toBe('pending');
    expect(translateUiState(B({ layoutReady: false, doc: zhDoc, version: 'mismatch' }))).toBe('pending');
  });
  it('其余五档', () => {
    expect(translateUiState(B({ loadError: 'x' }))).toBe('invalid');
    expect(translateUiState(B({}))).toBe('none');
    expect(translateUiState(B({ doc: zhDoc, version: 'mismatch' }))).toBe('mismatch');
    expect(translateUiState(B({ doc: zhDoc, dual: true }))).toBe('active');
    expect(translateUiState(B({ doc: zhDoc }))).toBe('ready');
  });
});

describe('canPressTranslate', () => {
  it.each([['none', B({})], ['invalid', B({ loadError: 'x' })], ['mismatch', B({ doc: zhDoc, version: 'mismatch' })],
           ['ready', B({ doc: zhDoc })], ['active', B({ doc: zhDoc, dual: true })]])('%s 放行', (_n, b) => {
    expect(canPressTranslate(b)).toBe(true);
  });
  it.each([['pending', B({ layoutReady: false })],
           ['translating', B({ doc: zhDoc, dual: true, job: { phase: 'extract', done: 0, total: 3, failed: 0 } })]])('%s 不放行', (_n, b) => {
    expect(canPressTranslate(b)).toBe(false);
  });
});

describe('setJob', () => {
  it('写入与清空', () => {
    const st = usePdfTranslationStore.getState();
    st.setJob('t', { phase: 'extract', done: 1, total: 3, failed: 0 });
    expect(usePdfTranslationStore.getState().buckets.t.job?.done).toBe(1);
    usePdfTranslationStore.getState().setJob('t', null);
    expect(usePdfTranslationStore.getState().buckets.t.job).toBeNull();
    usePdfTranslationStore.getState().drop('t');
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
