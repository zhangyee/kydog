import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount } from '../../../../test-support/miniReact';
import type { TranslatedDoc } from '../../../../shared/zhSidecar';

/**
 * **工具栏翻译键的文案与可按性**（原先由 e2e/57「翻译键六态」与「Notice——几何越界丢块、
 * 没写源摘要…都不禁用对照」守着）。
 *
 * 真挂载一遍 PdfToolbar（miniReact），读 `pdf-translate` 那颗 IconButton 收到的 `tooltip` 与
 * `disabled` —— 断言的是**组件接线之后**按钮拿到了什么，不是 TRANSLATE_TIP 这张表自己长什么样：
 * 表对了、组件却接错了态（比如拿 `translateBucket` 之外的东西推态）也会在这里红。
 *
 * 守不住的：IconButton 把 tooltip 写成 `aria-label` 那一步（子组件在 miniReact 里不展开）。
 *
 * 桶走 store 的 action 建，与 PdfFileTab 的 loadTranslation 写桶是同一条路：
 *  - none：`pdf.translation.load` 对 ENOENT 回 `{ doc: null }` → setLoaded(null)；
 *  - invalid：边车 JSON 坏了，主进程抛 → setLoadError；
 *  - mismatch：摘要对不上 → setLoaded(doc, 'mismatch')；
 *  - ready：摘要对得上 → setLoaded(doc, 'ok')。
 * 四个都先 setLayoutReady(true)：页尺寸没预取完时一律是 pending（禁用），那是另一态。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

// 同 narrowMode.test.tsx：两个 store 只把 React 订阅那一层换成直读，getState / setState 用真身。
vi.mock('./pdfTranslationStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./pdfTranslationStore')>();
  const real = mod.usePdfTranslationStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, usePdfTranslationStore: hook };
});

vi.mock('./pdfAnnotationStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./pdfAnnotationStore')>();
  const real = mod.usePdfAnnotationStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, usePdfAnnotationStore: hook };
});

const { PdfToolbar } = await import('./PdfToolbar');
const { usePdfTranslationStore } = await import('./pdfTranslationStore');
const { usePdfAnnotationStore } = await import('./pdfAnnotationStore');

const T = '/proj/paper.pdf';
const st = () => usePdfTranslationStore.getState();

function zh(source?: { sha256: string; bytes: number }): TranslatedDoc {
  return {
    version: 1, pdf: 'paper.pdf', lang: { in: 'en', out: 'zh' }, source,
    blocks: [{ id: 'ok1', page: 1, x: 60, y: 200, width: 460, height: 120, fontSize: 11, kind: 'text', source: 'a', target: '甲' }],
  };
}

/** 挂一次工具栏。 */
function mountToolbar() {
  return mount(PdfToolbar, {
    tabId: T, pageLabel: '1 / 1', zoomPct: 100,
    onToggleDual: () => {}, onRetranslate: () => {}, onRetranslatePage: () => {}, onRetryFailed: () => {}, onDelete: () => {},
  });
}

/** 挂一次工具栏，取翻译键收到的两个 prop。 */
function translateKey(): { tooltip: unknown; disabled: unknown } {
  const btn = mountToolbar().find('pdf-translate');
  return { tooltip: btn.props.tooltip, disabled: btn.props.disabled };
}

beforeEach(() => {
  usePdfTranslationStore.setState({ buckets: {} });
  usePdfAnnotationStore.setState({ buckets: {} });
});

describe('翻译键：四种边车状态各自的文案，全都可按（e2e/57「翻译键六态」）', () => {
  it('页尺寸还没预取完（pending）→ 禁用：下面几条的 disabled === false 因此不是 prop 缺席撞出来的', () => {
    st().setLoaded(T, zh({ sha256: 'aa', bytes: 10 }), 'ok', 0);
    expect(translateKey()).toEqual({ tooltip: '翻译对照 · 正在准备页面', disabled: true });
    // 同一个桶，页尺寸到位 → 可按
    st().setLayoutReady(T, true);
    expect(translateKey()).toEqual({ tooltip: '翻译对照 · L', disabled: false });
  });

  it('没有译文（none）→「翻译 · L」', () => {
    st().setLayoutReady(T, true);
    st().setLoaded(T, null, 'unknown', 0);
    expect(translateKey()).toEqual({ tooltip: '翻译 · L', disabled: false });
  });

  it('边车结构坏了（invalid）→「重新翻译 · L」', () => {
    st().setLayoutReady(T, true);
    st().setLoadError(T, 'Unexpected token b in JSON at position 1');
    expect(translateKey()).toEqual({ tooltip: '重新翻译 · L', disabled: false });
  });

  it('摘要对不上当前 PDF（mismatch）→「重新翻译 · L」', () => {
    st().setLayoutReady(T, true);
    st().setLoaded(T, zh({ sha256: '0'.repeat(64), bytes: 1 }), 'mismatch', 0);
    expect(translateKey()).toEqual({ tooltip: '重新翻译 · L', disabled: false });
  });

  it('摘要对得上（ready）→「翻译对照 · L」', () => {
    st().setLayoutReady(T, true);
    st().setLoaded(T, zh({ sha256: 'aa', bytes: 10 }), 'ok', 0);
    expect(translateKey()).toEqual({ tooltip: '翻译对照 · L', disabled: false });
  });
});

describe('翻译键：Notice 那两条「能用但要提示」不禁用对照（e2e/57「Notice——…都不禁用对照」）', () => {
  it('几何越界丢了块（dropped > 0，摘要对得上）→ 仍是「翻译对照 · L」、可按', () => {
    st().setLayoutReady(T, true);
    st().setLoaded(T, zh({ sha256: 'aa', bytes: 10 }), 'ok', 1);
    expect(translateKey()).toEqual({ tooltip: '翻译对照 · L', disabled: false });
  });

  it('边车没写源摘要（version unknown）→ 仍是「翻译对照 · L」、可按', () => {
    st().setLayoutReady(T, true);
    st().setLoaded(T, zh(), 'unknown', 0);
    expect(translateKey()).toEqual({ tooltip: '翻译对照 · L', disabled: false });
  });
});

describe('工具按钮：active 态统一走强调色 accent，与 md 胶囊同款（PDF 胶囊补的第二处，见协调者更正 2）', () => {
  it('select 是默认工具：active=true、activeVariant=accent；切到 highlight 后 select 翻 false、highlight 翻 true，accent 这个 prop 两边都在', () => {
    // 正向先来：默认桶 tool 是 'select'（pdfAnnotationStore 空桶默认值），没手动 setTool 也该是 active。
    const before = mountToolbar();
    expect(before.find('pdf-tool-select').props).toMatchObject({ active: true, activeVariant: 'accent' });
    expect(before.find('pdf-tool-highlight').props).toMatchObject({ active: false, activeVariant: 'accent' });
    expect(before.find('pdf-tool-note').props).toMatchObject({ active: false, activeVariant: 'accent' });

    // 反向紧跟：切到 highlight 后再挂一次，select 的 active 翻回 false——同一条用例里翻一遍面，
    // 不靠隔壁一条反向对照兜底（CLAUDE.md 否定断言的要求）。
    usePdfAnnotationStore.getState().setTool(T, 'highlight');
    const after = mountToolbar();
    expect(after.find('pdf-tool-select').props).toMatchObject({ active: false, activeVariant: 'accent' });
    expect(after.find('pdf-tool-highlight').props).toMatchObject({ active: true, activeVariant: 'accent' });
  });

  it('翻译键：进对照（active）时 active=true、accent；退出对照后 active=false，accent 这个 prop 不变', () => {
    st().setLayoutReady(T, true);
    st().setLoaded(T, zh({ sha256: 'aa', bytes: 10 }), 'ok', 0);

    // 正向先来：进对照。
    st().setDual(T, true);
    const active = mountToolbar();
    expect(active.find('pdf-translate').props).toMatchObject({ active: true, activeVariant: 'accent' });

    // 反向紧跟：退出对照，同一颗按钮的 active 翻回 false。
    st().setDual(T, false);
    const ready = mountToolbar();
    expect(ready.find('pdf-translate').props).toMatchObject({ active: false, activeVariant: 'accent' });
  });
});
