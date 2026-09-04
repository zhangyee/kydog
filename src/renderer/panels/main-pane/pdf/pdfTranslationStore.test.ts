import { describe, expect, it } from 'vitest';
import { checkVersion } from './pdfTranslationStore';
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
