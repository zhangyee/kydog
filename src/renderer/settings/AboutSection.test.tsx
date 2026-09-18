import { describe, it, expect, beforeEach, vi } from 'vitest';
import { findAllWhere, findOneWhere, type MiniElement, type Mounted } from '../../test-support/miniReact';

/**
 * **关于页的视图切换**：当前篇 / 往期篇 / 开源许可 / 隐私与统计四种视图之间怎么走。
 *
 * 篇目是替身（三篇合成文档），这份用例因此**不绑任何真实文章**：新增、改写 `src/about/`
 * 不会让它红。文章本身的内容（哪篇最新、licenses 里有 OFL 全文、privacy 的披露项）
 * 由 `about/aboutDocs.test.ts` 读真文件守着，这里只守「组件把哪一份接到哪个节点上」。
 *
 * 子组件在 miniReact 里不展开：`AboutMarkdown` / `PrivacyPanel` / `UpdateBlock`
 * 只是树上的一个节点，按身份找、看它的 props。守不住的是渲染出来的真实文字与排版。
 */

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

// 三篇而不是两篇：两篇时「往期 = 除最新外的全部」与「往期 = 最后一篇」「往期 = 第二篇」
// 分不开。已按 date 降序（ABOUT_DOCS 的约定），[0] 是当前篇。
vi.mock('./about/aboutDocs', () => ({
  ABOUT_DOCS: [
    { slug: 'c-new', title: '最新一篇的标题', date: '2026-09-01', body: '最新一篇的正文' },
    { slug: 'b-mid', title: '中间一篇的标题', date: '2026-06-01', body: '中间一篇的正文' },
    { slug: 'a-old', title: '最早一篇的标题', date: '2026-01-01', body: '最早一篇的正文' },
  ],
  ABOUT_LICENSES: '开源许可的原文',
  ABOUT_PRIVACY: '隐私说明的原文',
}));

// SettingsPane 那一条用到的两个 store：只把 React 订阅那一层换成直读（同 ThreeColumnLayout.test.tsx）。
vi.mock('../stores/uiStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../stores/uiStore')>();
  const real = mod.useUiStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useUiStore: hook };
});

vi.mock('../stores/settingsStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../stores/settingsStore')>();
  const real = mod.useSettingsStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useSettingsStore: hook };
});

const { mount } = await import('../../test-support/miniReact');
const { AboutSection } = await import('./AboutSection');
const { AboutMarkdown } = await import('./about/AboutMarkdown');
const { PrivacyPanel } = await import('./about/PrivacyPanel');
const { UpdateBlock } = await import('./UpdateBlock');
const { SettingsPane } = await import('./SettingsPane');
const { useUiStore } = await import('../stores/uiStore');
const { useSettingsStore } = await import('../stores/settingsStore');

function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf((node as { props?: { children?: unknown } }).props?.children);
}

type M = Mounted<Record<string, never>>;

const title = (m: M) => textOf(m.find('about-title'));
/** 正文块里那一个 AboutMarkdown 收到的 content。 */
const bodyContent = (m: M) => findOneWhere(m.find('about-body'), (el) => el.type === AboutMarkdown).props.content as string;
const archiveItems = (m: M): MiniElement[] => findAllWhere(m.tree, (el) => el.props['data-testid'] === 'about-archive-item');
const current = (m: M) => archiveItems(m).map((el) => el.props['aria-current'] === 'true');
const click = (el: MiniElement) => { (el.props.onClick as () => void)(); };

describe('关于页：当前篇与往期', () => {
  it('默认展示 date 最大的那篇；往期是其余各篇、按原序列出，一条都不高亮', () => {
    const m = mount(AboutSection, {});
    expect(title(m)).toBe('最新一篇的标题');
    expect(bodyContent(m)).toBe('最新一篇的正文');
    // 更新块挂在当前篇视图里（42-auto-update 那条的「关于页更新块常驻」）
    expect(findAllWhere(m.tree, (el) => el.type === UpdateBlock)).toHaveLength(1);

    const items = archiveItems(m);
    expect(items.map(textOf)).toEqual(['2026-06-01中间一篇的标题', '2026-01-01最早一篇的标题']);
    expect(current(m)).toEqual([false, false]);
  });

  it('切到往期：标题与正文换成那一篇，高亮落在它自己那一行；「回到最新」出现并能回去', () => {
    const m = mount(AboutSection, {});
    // 负向对照：切过去之前「回到最新」不在
    expect(m.query('about-back-to-latest')).toBeNull();

    click(archiveItems(m)[0]);
    expect(title(m)).toBe('中间一篇的标题');
    expect(bodyContent(m)).toBe('中间一篇的正文');
    expect(current(m)).toEqual([true, false]);
    expect(m.query('about-back-to-latest')).not.toBeNull();
    // 往期列表不随视图变化：看往期时它仍是「除最新外的全部」，列表不跳
    expect(archiveItems(m)).toHaveLength(2);

    // 换一篇：高亮跟着走，不是「第一行恒亮」
    click(archiveItems(m)[1]);
    expect(title(m)).toBe('最早一篇的标题');
    expect(bodyContent(m)).toBe('最早一篇的正文');
    expect(current(m)).toEqual([false, true]);

    click(m.find('about-back-to-latest'));
    expect(title(m)).toBe('最新一篇的标题');
    expect(bodyContent(m)).toBe('最新一篇的正文');
    expect(current(m)).toEqual([false, false]);
    expect(m.query('about-back-to-latest')).toBeNull();
  });
});

describe('关于页：底部两条文档入口', () => {
  it('两条入口并列，顺序是「开源许可」在前、「隐私与统计」在后', () => {
    const m = mount(AboutSection, {});
    const entries = findAllWhere(m.tree, (el) =>
      el.props['data-testid'] === 'about-licenses-entry' || el.props['data-testid'] === 'about-privacy-entry');
    expect(entries.map((el) => el.props['data-testid'])).toEqual(['about-licenses-entry', 'about-privacy-entry']);
    expect(textOf(entries[0])).toContain('开源许可');
    expect(textOf(entries[1])).toContain('隐私与统计');
  });

  it('开源许可整页替换：当前篇、往期、更新块都不在，只剩返回与许可原文；返回落回当前篇', () => {
    const m = mount(AboutSection, {});
    // 先看往期，再进许可页 —— 返回时要落回的是**当前篇**，不是进来之前看的那篇
    click(archiveItems(m)[0]);
    expect(title(m)).toBe('中间一篇的标题');

    expect(findAllWhere(m.tree, (el) => el.type === UpdateBlock)).toHaveLength(1);

    click(m.find('about-licenses-entry'));
    expect(m.query('about-title')).toBeNull();
    expect(archiveItems(m)).toHaveLength(0);
    expect(findAllWhere(m.tree, (el) => el.type === UpdateBlock)).toHaveLength(0);
    expect(m.query('about-licenses-back')).not.toBeNull();
    expect(findOneWhere(m.tree, (el) => el.type === AboutMarkdown).props.content).toBe('开源许可的原文');

    click(m.find('about-licenses-back'));
    expect(title(m)).toBe('最新一篇的标题');
    expect(m.query('about-licenses-back')).toBeNull();
    expect(archiveItems(m)).toHaveLength(2);
    expect(findAllWhere(m.tree, (el) => el.type === UpdateBlock)).toHaveLength(1);
  });

  it('隐私与统计同一套：整页换成 PrivacyPanel，返回落回当前篇', () => {
    const m = mount(AboutSection, {});
    // 负向对照在前：当前篇视图里没有 PrivacyPanel
    expect(findAllWhere(m.tree, (el) => el.type === PrivacyPanel)).toHaveLength(0);

    click(m.find('about-privacy-entry'));
    expect(m.query('about-title')).toBeNull();
    expect(archiveItems(m)).toHaveLength(0);
    expect(m.query('about-privacy-back')).not.toBeNull();
    expect(findAllWhere(m.tree, (el) => el.type === PrivacyPanel)).toHaveLength(1);

    click(m.find('about-privacy-back'));
    expect(title(m)).toBe('最新一篇的标题');
    expect(archiveItems(m)).toHaveLength(2);
    expect(m.query('about-privacy-back')).toBeNull();
    expect(findAllWhere(m.tree, (el) => el.type === PrivacyPanel)).toHaveLength(0);
  });
});

describe('关于页的版本行', () => {
  /**
   * 版本行挂在 **SettingsPane 的页头**，不在 AboutSection 里：AboutSection 的视图是它自己的
   * 局部 state，在 SettingsPane 看来只是一个子节点，怎么切都碰不到页头 —— 所以「切到往期后
   * 版本行逐字不变」在结构上成立，这里守的是它的前提：关于页确实挂着版本行，且读的是 appVersion。
   */
  beforeEach(() => {
    useUiStore.setState({ settingsTab: 'about', settingsDetailProviderId: null, settingsAddProviderOpen: false });
    useSettingsStore.setState({ appVersion: '7.8.9-test', settingsHealth: { kind: 'ok' } });
  });

  it('关于页页头有 v<appVersion>，正文是 AboutSection', () => {
    const m = mount(SettingsPane, {});
    expect(textOf(m.find('settings-version'))).toBe('v7.8.9-test');
    expect(findAllWhere(m.tree, (el) => el.type === AboutSection)).toHaveLength(1);
  });

  it('AboutSection 自己不再渲染一份版本行（四种视图都不）', () => {
    // 正向：SettingsPane 里按同一个 testid 查得到它（上一条），查找本身没坏
    const pane = mount(SettingsPane, {});
    expect(pane.query('settings-version')).not.toBeNull();

    const m = mount(AboutSection, {});
    expect(m.query('settings-version')).toBeNull();
    click(archiveItems(m)[0]);
    expect(m.query('settings-version')).toBeNull();
    click(m.find('about-licenses-entry'));
    expect(m.query('settings-version')).toBeNull();
    click(m.find('about-licenses-back'));
    click(m.find('about-privacy-entry'));
    expect(m.query('settings-version')).toBeNull();
  });
});
