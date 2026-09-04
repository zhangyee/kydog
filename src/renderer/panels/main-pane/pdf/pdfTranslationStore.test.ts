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
