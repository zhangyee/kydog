import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type FakeElement, type Mounted } from '../../../../test-support/miniReact';
import type { FileTab } from '../../../stores/uiStore';

/**
 * **HTML 报告 tab 的「组件那一半」**：三条接线，原先只有 e2e/46-html-tab 守着。
 *
 *  1. 阅读字号在注入 effect 的依赖里 —— 换档之后 srcDoc 要重建，报告才跟着变字号。
 *     `readingFontSize` 在那个 effect 里**一次都没被读**（字号是从宿主根元素的计算样式里
 *     读的），它在依赖里只是为了让 effect 重跑；exhaustive-deps 不会要求它，删掉也不报任何错。
 *  2. `reloadNonce` 加一要触发重读文件 —— 而且 tab 已经是 `ready` 也要重读（组件里那段 ⚠️：
 *     故意没有 PdfFileTab 那条 `status !== 'loading'` 守卫）。
 *  3. 切走再切回（isActive false → true）要重新聚焦，而且 **`el.focus()` 与
 *     `el.contentWindow.focus()` 两步都要做** —— 只做第一步时焦点停在宿主文档的 iframe 元素上，
 *     报告里的方向键收不到，成品里真这样发过（见组件里那段注释）。
 *
 * 真挂载一遍（miniReact：真调组件函数、先挂 ref 再跑 effect）。守不住的是真 iframe 的行为：
 * srcdoc 真的被解析、CSS 变量真的生效、焦点真的进了子文档——那些仍然只有 e2e 看得见。
 *
 * `./reportTheme` 的三处 DOM 依赖换成纯字符串替身（node 没有 DOMParser / getComputedStyle）：
 *  - `readHostVar` 读下面那张 `host` 表，模拟 ThemeApplier 写在宿主根元素上的计算值；
 *  - `injectHostTheme` 只把 theme / css / html 原样拼起来，断言 srcDoc 里带了什么；
 *  - `inlineLocalImages` 原样返回。
 * `buildHostThemeCss` 用真的：字号是经它从 `readHostVar` 读出来、拼进 `:root` 块的。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

// 同 narrowMode.test.tsx：只把 React 订阅那一层换成直读，getState / setState 用真身。
vi.mock('../../../stores/uiStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../stores/uiStore')>();
  const real = mod.useUiStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useUiStore: hook };
});

const { host } = vi.hoisted(() => ({ host: {} as Record<string, string> }));

vi.mock('./reportTheme', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./reportTheme')>();
  return {
    ...mod,
    readHostVar: (name: string) => host[name] ?? '',
    injectHostTheme: (html: string, css: string, theme: string) => `<!--theme:${theme}-->\n<style>${css}</style>\n${html}`,
    inlineLocalImages: (html: string) => Promise.resolve(html),
  };
});

const { HtmlFileTab } = await import('./HtmlFileTab');
const { useUiStore } = await import('../../../stores/uiStore');

const PATH = '/proj/report.html';

function tab(patch: Partial<FileTab> = {}): FileTab {
  return {
    id: PATH, path: PATH, kind: 'html', title: 'report.html',
    status: 'loading', diskContent: null, dirty: false, reloadNonce: 0,
    ...patch,
  };
}

type Props = { tab: FileTab; isActive: boolean };

/** 盘上的内容（每次 readBytes 读的都是此刻的值）与读盘记录。 */
const disk = { text: '' };
const reads: string[] = [];

beforeEach(() => {
  reads.length = 0;
  disk.text = '<h1 id="heading">知识地图</h1>';
  for (const k of Object.keys(host)) delete host[k];
  host['--reading-font-size'] = '15px';
  useUiStore.setState(useUiStore.getInitialState());
  (globalThis as unknown as { window: unknown }).window = {
    kydog: {
      invoke: (method: string, args: { path: string }) => {
        if (method !== 'file.readBytes') return Promise.reject(new Error(`意外的 RPC：${method}`));
        reads.push(args.path);
        return Promise.resolve({ bytes: new TextEncoder().encode(disk.text) });
      },
    },
  };
});

afterEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).window;
});

const srcDocOf = (m: Mounted<Props>): string => m.find(`html-frame-${PATH}`).props.srcDoc as string;

describe('HtmlFileTab：阅读字号换档，srcDoc 跟着重建（e2e/46「报告跟随阅读字号」）', () => {
  it('readingFontSize 变了 → 重新读宿主变量、重新注入；只是重渲染不重建', async () => {
    const t = tab();
    const m = mount(HtmlFileTab, { tab: t, isActive: true });
    await m.settle();
    expect(srcDocOf(m)).toContain('--reading-font-size: 15px;');

    // ThemeApplier 已经把根元素的字号改成大号那一档，但 store 里还没换档：普通的一次重渲染
    // 不该重建。有这一步，下面那次重建才说得清是**字号依赖**触发的，不是「每次渲染都重建」。
    host['--reading-font-size'] = '17px';
    m.rerender({ tab: t, isActive: true });
    expect(srcDocOf(m)).toContain('--reading-font-size: 15px;');

    // 主题一直是 vellum 没动：theme 也在同一个依赖数组里，换了它也会重建，就说明不了字号那一项。
    expect(useUiStore.getState().theme).toBe('vellum');
    useUiStore.setState({ readingFontSize: 'large' });
    m.rerender({ tab: t, isActive: true });
    expect(srcDocOf(m)).toContain('--reading-font-size: 17px;');
    expect(srcDocOf(m)).toContain('<!--theme:vellum-->');
  });
});

describe('HtmlFileTab：reloadNonce 加一就重读文件（e2e/46「文件内容改了 tab 自动重载」）', () => {
  it('tab 已是 ready 也照样重读，新内容进 srcDoc；nonce 没变的重渲染不读盘', async () => {
    const t = tab();
    const m = mount(HtmlFileTab, { tab: t, isActive: true });
    await m.settle();
    expect(reads).toEqual([PATH]);
    expect(srcDocOf(m)).toContain('知识地图</h1>');

    // agent 从进程外重写了报告
    disk.text = '<h1 id="heading">知识地图 v2</h1>';

    // 对照：首读完成后 tab 被置成 ready，这次重渲染 nonce 没变 —— 不读盘，内容还是旧的。
    m.rerender({ tab: { ...t, status: 'ready' }, isActive: true });
    await m.settle();
    expect(reads).toEqual([PATH]);
    expect(srcDocOf(m)).toContain('知识地图</h1>');

    // file.changed → markFileChanged 把 nonce 加一。status 仍是 ready：这正是 ⚠️ 那段说的情形，
    // 补一条「只在 loading 时读」的守卫，这里就会停在旧内容上。
    m.rerender({ tab: { ...t, status: 'ready', reloadNonce: 1 }, isActive: true });
    await m.settle();
    expect(reads).toEqual([PATH, PATH]);
    expect(srcDocOf(m)).toContain('知识地图 v2</h1>');
  });
});

describe('HtmlFileTab：切走再切回，焦点两步都交给 iframe（e2e/46「方向键在节间跳转（切走再切回）」）', () => {
  it('isActive false → true：iframe.focus() 与 iframe.contentWindow.focus() 各调一次', async () => {
    const t = tab();
    const m = mount(HtmlFileTab, { tab: t, isActive: true });
    await m.settle();

    const el = (m.find(`html-frame-${PATH}`).props.ref as { current: FakeElement }).current;
    expect(el.tagName).toBe('IFRAME');
    const hostFocus = vi.spyOn(el, 'focus');
    const innerFocus = vi.spyOn(el.contentWindow as { focus: () => void }, 'focus');

    // 切到别的 tab：保持挂载、只是 display:none（MainPane.tsx），srcDoc 不变。
    m.rerender({ tab: t, isActive: false });
    expect(hostFocus).not.toHaveBeenCalled();
    expect(innerFocus).not.toHaveBeenCalled();

    // 切回来：srcDoc 仍没变，重新聚焦只能靠 isActive 这一项依赖。
    m.rerender({ tab: t, isActive: true });
    expect(hostFocus).toHaveBeenCalledTimes(1);
    // 第二步才让报告自己的 document 收得到方向键（成品里漏过的就是它）。
    expect(innerFocus).toHaveBeenCalledTimes(1);
  });
});
