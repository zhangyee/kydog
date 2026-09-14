import { describe, it, expect, vi } from 'vitest';
import { mount } from '../../../test-support/miniReact';
import type { BrowserTabInfo, ViewportMode } from '../../../shared/types';

/**
 * **地址栏**：一条纯函数（`normalizeTyped`）+ 「1:1 / 适配」开关的组件那一半。
 *
 * 开关那一条要守的是**判据来自哪儿**：亮不亮读的必须是 `tab.viewportMode`
 * （主进程广播回来的那份真相），不是本地的一个 `useState`。本地记一份的话，
 * agent 在 `markDriving` 里把档位恢复成 `fit` 之后，开关会停在 1:1 上，
 * 而页面已经回到 1280 —— 一个说谎的开关比没有开关更糟。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

const { UrlBar, normalizeTyped } = await import('./UrlBar');

function tab(patch: Partial<BrowserTabInfo> = {}): BrowserTabInfo {
  return {
    id: 't1', url: 'https://example.org/', title: '', loading: false,
    owner: 'user', canGoBack: false, canGoForward: false, viewportMode: 'fit',
    ...patch,
  };
}

function make(t: BrowserTabInfo | null) {
  const modes: ViewportMode[] = [];
  const m = mount(UrlBar, {
    tab: t,
    onGo: () => Promise.resolve(),
    onNav: () => {},
    onViewportMode: (mode: ViewportMode) => { modes.push(mode); },
  });
  return { m, modes };
}

describe('normalizeTyped：只补 scheme，不判合不合法', () => {
  it.each([
    ['www.cnki.net', 'https://www.cnki.net'],
    ['  example.org  ', 'https://example.org'],
    ['http://a.b/', 'http://a.b/'],
    ['HTTPS://A.B/', 'HTTPS://A.B/'],
    ['ftp://a.b/', 'ftp://a.b/'],
    ['', ''],
  ])('%s → %s', (raw, want) => {
    expect(normalizeTyped(raw)).toBe(want);
  });
});

describe('「1:1 / 适配」开关', () => {
  it('现在是适配 → 灯灭；按一下送 oneToOne 过去', () => {
    const { m, modes } = make(tab());
    const btn = m.find('browser-viewport-mode');
    expect(btn.props.active).toBe(false);
    (btn.props.onClick as () => void)();
    expect(modes).toEqual(['oneToOne']);
  });

  it('现在是 1:1 → 灯亮；按一下送 fit 回去', () => {
    const { m, modes } = make(tab({ viewportMode: 'oneToOne' }));
    const btn = m.find('browser-viewport-mode');
    expect(btn.props.active).toBe(true);
    (btn.props.onClick as () => void)();
    expect(modes).toEqual(['fit']);
  });

  it('**判据来自主进程那份真相**：同一次挂载里 tab 换了档位，灯跟着换', () => {
    const { m } = make(tab({ viewportMode: 'oneToOne' }));
    expect(m.find('browser-viewport-mode').props.active).toBe(true);

    // agent 的 markDriving 把它恢复成 fit，新一帧广播下来。
    m.rerender({
      tab: tab({ viewportMode: 'fit' }),
      onGo: () => Promise.resolve(), onNav: () => {}, onViewportMode: () => {},
    });
    expect(m.find('browser-viewport-mode').props.active).toBe(false);
  });

  it('一个标签都没有时按不动', () => {
    const { m, modes } = make(null);
    const btn = m.find('browser-viewport-mode');
    expect(btn.props.disabled).toBe(true);
    expect(btn.props.active).toBe(false);
    expect(modes).toEqual([]);
  });
});

/**
 * **Task 4**：新建标签只剩 `TabStrip` 右端那一个入口——地址栏里原来那个 `+`
 * （「下一次回车开在新标签里」那套 `newTab` state）整个删掉了。
 */
describe('地址栏里那个 + 没了（新建标签只有一个入口）', () => {
  it('挂载 UrlBar 找不到 browser-new-tab 这个节点', () => {
    const { m } = make(tab());
    expect(m.query('browser-new-tab')).toBeNull();
  });
});

/**
 * **回车之后地址栏不许闪空**（2026-09-14 手测）。
 *
 * 主进程的 `tab.url` 是**已提交**的地址：`did-navigate` 之前它还是旧的（`+` 开的空白标签是空串）。
 * 回车那一刻 `editing` 翻回 false，输入框若立刻跟回 `tab.url`，刚打的网址就被冲掉、等页面提交才
 * 重新出现 —— 用户以为没输进去。判据是**这次 `browser.open` 有没有结论**（它在导航落定、失败、
 * 被拦、超时时才返回），不是计时器。
 */
describe('回车之后地址栏不闪空', () => {
  function typeAndEnter(m: ReturnType<typeof mount>, text: string) {
    const input = () => m.find('browser-url');
    (input().props.onFocus as () => void)();
    (input().props.onChange as (e: { target: { value: string } }) => void)({ target: { value: text } });
    (input().props.onKeyDown as (e: { key: string; preventDefault: () => void }) => void)(
      { key: 'Enter', preventDefault: () => {} },
    );
    (input().props.onBlur as () => void)();   // 真浏览器里 submit 的 blur() 会触发它
  }

  it('这次打开有结论之前一直显示提交的网址；有结论之后跟回主进程的真实网址', async () => {
    let finish!: () => void;
    const submitted: string[] = [];
    const props = (t: BrowserTabInfo) => ({
      tab: t,
      onGo: (url: string) => { submitted.push(url); return new Promise<void>((r) => { finish = r; }); },
      onNav: () => {}, onViewportMode: () => {},
    });
    const blank = tab({ url: '' });
    const m = mount(UrlBar, props(blank));
    const value = () => m.find('browser-url').props.value as string;

    typeAndEnter(m, 'arxiv.org/list/cs.LG/recent');
    expect(submitted).toEqual(['https://arxiv.org/list/cs.LG/recent']);
    expect(value(), '导航还没提交（tab.url 仍是空串），刚打的网址不许被冲掉')
      .toBe('https://arxiv.org/list/cs.LG/recent');

    // 导航途中主进程照常广播（loading 翻成 true），url 仍是旧的。
    m.rerender(props({ ...blank, loading: true }));
    expect(value()).toBe('https://arxiv.org/list/cs.LG/recent');

    // 翻面：这次打开有了结论（重定向到带参数的最终地址），输入框跟回主进程的真相。
    m.rerender(props({ ...blank, url: 'https://arxiv.org/list/cs.LG/recent?skip=0', loading: false }));
    finish();
    await m.settle();
    expect(value()).toBe('https://arxiv.org/list/cs.LG/recent?skip=0');
  });

  it('打开被拒（比如网址闸拦下）：有了结论就回到这个标签真实的网址', async () => {
    let reject!: (e: Error) => void;
    const m = mount(UrlBar, {
      tab: tab({ url: 'https://example.org/' }),
      onGo: () => new Promise<void>((_r, j) => { reject = j; }),
      onNav: () => {}, onViewportMode: () => {},
    });
    const value = () => m.find('browser-url').props.value as string;

    // 内网地址过不了主进程的网址闸，browser.open 会被拒。
    typeAndEnter(m, '192.168.1.1/admin');
    expect(value(), '结论出来之前显示的是刚提交的那个').toBe('https://192.168.1.1/admin');
    reject(new Error('blocked'));
    await m.settle();
    expect(value()).toBe('https://example.org/');
  });
});
