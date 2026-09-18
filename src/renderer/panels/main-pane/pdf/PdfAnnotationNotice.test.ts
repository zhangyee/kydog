import { describe, it, expect, beforeEach } from 'vitest';
import type { TranslatedDoc } from '../../../../shared/zhSidecar';
import { noticeText } from './PdfAnnotationNotice';
import { canPressTranslate, translateUiState, usePdfTranslationStore, type VersionState } from './pdfTranslationStore';

/**
 * Notice 里译文侧那两条「能用但要提示」的消息（原先由 e2e/57「Notice——几何越界丢块、没写
 * 源摘要，两条都提示且都不禁用对照」守着）：
 *
 *  - 几何越界被丢了块（dropped > 0）→ 提示条数；
 *  - 边车没写 source 摘要（version unknown，且有 doc）→ 提示没法校验版本。
 *
 * 两条都**不禁用**对照：只丢了一条越界块、或只是没法校验版本，剩下的照样能读——提示不该顺手
 * 把功能关掉。判据取同一个桶喂给 canPressTranslate（工具栏 disabled 与 L 键共用的那份，
 * 工具栏确实接的是它，见 PdfToolbar.test.tsx）。
 *
 * 桶一律走 store 的 action 建（setLayoutReady / setLoaded），与 PdfFileTab 的 loadTranslation
 * 写桶走同一条路，不手拼 TBucket。
 */

const T = '/proj/paper.pdf';
const st = () => usePdfTranslationStore.getState();

function zh(source?: { sha256: string; bytes: number }): TranslatedDoc {
  return {
    version: 1, pdf: 'paper.pdf', lang: { in: 'en', out: 'zh' }, source,
    blocks: [{ id: 'ok1', page: 1, x: 60, y: 200, width: 460, height: 120, fontSize: 11, kind: 'text', source: 'a', target: '甲' }],
  };
}

/** 页尺寸已预取完（layoutReady）、边车已加载——就是打开一份带译文的 PDF 之后的样子。 */
function loaded(doc: TranslatedDoc, version: VersionState, dropped: number) {
  st().setLayoutReady(T, true);
  st().setLoaded(T, doc, version, dropped);
  return st().buckets[T];
}

const notice = (t: ReturnType<typeof loaded>) => noticeText({
  pdfPath: T, loadError: null, saveError: null, translateError: null, t,
});

beforeEach(() => {
  usePdfTranslationStore.setState({ buckets: {} });
});

describe('noticeText：译文侧「能用但要提示」的两条', () => {
  it('几何越界丢了一条块 → 提示条数；对照仍可进', () => {
    // version 是 ok：换成 unknown 就会先撞上摘要那一条（优先级更高），测不到这一支。
    const t = loaded(zh({ sha256: 'aa', bytes: 10 }), 'ok', 1);
    expect(notice(t)).toEqual({ text: '1 条译文块超出页面范围，已跳过', isFailedPages: false });
    expect(translateUiState(t)).toBe('ready');
    expect(canPressTranslate(t)).toBe(true);
  });

  it('边车没写 source 摘要 → 提示没法校验版本；对照仍可进', () => {
    const t = loaded(zh(), 'unknown', 0);
    expect(notice(t)).toEqual({ text: '未记录源文件摘要，无法确认译文与当前 PDF 匹配', isFailedPages: false });
    expect(translateUiState(t)).toBe('ready');
    expect(canPressTranslate(t)).toBe(true);
  });

  it('两条同时成立：Notice 只有一行，摘要那条优先；对照仍可进', () => {
    const t = loaded(zh(), 'unknown', 2);
    expect(notice(t)?.text).toBe('未记录源文件摘要，无法确认译文与当前 PDF 匹配');
    expect(canPressTranslate(t)).toBe(true);

    // 同一个桶里 dropped 那条确实成立：摘要一旦对上（version 变 ok），显示的就轮到它。
    const ok = loaded(zh({ sha256: 'aa', bytes: 10 }), 'ok', 2);
    expect(notice(ok)?.text).toBe('2 条译文块超出页面范围，已跳过');
  });

  it('对照：版本对不上（mismatch）是另一回事——提示且进不了对照，主键变成「重新翻译」', () => {
    // 上面几条 translateUiState === 'ready' 的反面：证明它不是对任何「有提示的桶」都判成可进对照。
    // （mismatch 的键仍可点——二期起它的动作是重跑流水线，不是进对照——所以这里比的是态，不是 canPress。）
    const t = loaded(zh({ sha256: '0'.repeat(64), bytes: 1 }), 'mismatch', 0);
    expect(notice(t)?.text).toBe('译文对应的是另一个版本的 PDF；请重新翻译，或重新打开该文件');
    expect(translateUiState(t)).toBe('mismatch');
  });
});
