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
    onGo: () => {},
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
      onGo: () => {}, onNav: () => {}, onViewportMode: () => {},
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
