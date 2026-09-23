import { describe, expect, it, vi } from 'vitest';
import { findAllWhere, mount } from '../../../test-support/miniReact';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

const { TabStrip, revealActiveTab } = await import('./TabStrip');

describe('主内容标签条的两级宽度策略', () => {
  it('thread 在固定槽里；文件 tab 在右侧独立执行收窄与横向滚动', () => {
    const m = mount(TabStrip, {
      tabs: [
        { id: 'thread-1', kind: 'thread', title: '研究对话' },
        { id: '/p/a.md', kind: 'md', title: 'a.md' },
        { id: '/p/b.pdf', kind: 'pdf', title: 'b.pdf' },
      ],
      activeId: '/p/b.pdf',
    });

    const strip = m.find('main-tabstrip');
    expect(strip.props.style.height).toBe(34);
    expect(strip.props.className).toContain('overflow-hidden');

    const pinned = m.find('main-tabpinned');
    const scroll = m.find('main-tabscroll');
    expect(pinned.props.style).toMatchObject({ flexBasis: 220, minWidth: 140, maxWidth: 220 });
    expect(scroll.props.className).toContain('overflow-x-auto');
    expect(scroll.props.className).toContain('overflow-y-hidden');

    const pinnedIds = findAllWhere(pinned, (el) => typeof el.props['data-testid'] === 'string')
      .map((el) => el.props['data-testid']);
    const scrollingIds = findAllWhere(scroll, (el) => typeof el.props['data-testid'] === 'string')
      .map((el) => el.props['data-testid']);
    // 正向先证明两个查找都能命中各自的 tab，再断 thread 没混进滚动区。
    expect(pinnedIds).toContain('tab-thread-1');
    expect(scrollingIds).toEqual(expect.arrayContaining(['tab-/p/a.md', 'tab-/p/b.pdf']));
    expect(scrollingIds).not.toContain('tab-thread-1');

    const tabNodes = findAllWhere(m.tree, (el) =>
      typeof el.props['data-testid'] === 'string'
      && /^tab-(thread-1|\/p\/(a\.md|b\.pdf))$/.test(el.props['data-testid']),
    );
    expect(tabNodes).toHaveLength(3);
    expect(tabNodes.map((el) => ({
      flex: el.props.style.flex,
      minWidth: el.props.style.minWidth,
      maxWidth: el.props.style.maxWidth,
    }))).toEqual([
      { flex: '1 1 0', minWidth: 0, maxWidth: 'none' },
      { flex: '1 1 220px', minWidth: 120, maxWidth: 220 },
      { flex: '1 1 220px', minWidth: 120, maxWidth: 220 },
    ]);
    m.unmount();
  });

  it('活动项用浏览器的 nearest 规则滚进视野', () => {
    const scrollIntoView = vi.fn();
    revealActiveTab({ scrollIntoView });
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
  });
});
