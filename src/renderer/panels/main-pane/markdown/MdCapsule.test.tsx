import { describe, it, expect, vi } from 'vitest';
import { findAllWhere, mount } from '../../../../test-support/miniReact';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

const { MdCapsule } = await import('./MdCapsule');
const { IconButton, Tooltip } = await import('../../../shared');

describe('MdCapsule', () => {
  const btn = (tree: unknown) => findAllWhere(tree as never, (el) => el.type === IconButton)[0];
  const tips = (tree: unknown) => findAllWhere(tree as never, (el) => el.type === Tooltip);

  it('有对话：可点、tooltip「评论模式」、active 跟着模式；没对话：禁用，IconButton 自己因为 disabled 不会渲染 tooltip（见 IconButton.tsx），外面手动包一层 Tooltip 补上「先打开一个对话」', () => {
    // 没对话这条先来：正向证明「树上找得到 Tooltip、content 对」——下面「有对话时不额外包
    // Tooltip」那句 toHaveLength(0) 靠的就是这同一个 tips() 查找，得先证明它真的找得到东西，
    // 不是查找本身坏了才导致「找不到」（CLAUDE.md 否定断言的要求）。
    const none = mount(MdCapsule, { commentMode: false, canComment: false, onToggleComment: () => {} });
    expect(btn(none.tree).props).toMatchObject({ disabled: true, tooltip: '先打开一个对话' });
    const noneTips = tips(none.tree);
    expect(noneTips).toHaveLength(1);
    expect(noneTips[0].props.content).toBe('先打开一个对话');

    const on = mount(MdCapsule, { commentMode: true, canComment: true, onToggleComment: () => {} });
    expect(btn(on.tree).props).toMatchObject({ disabled: false, tooltip: '评论模式', active: true });
    expect(on.find('md-capsule').props['data-comment-mode']).toBe('on');
    // 有对话：按钮没 disabled，IconButton 自己那套 tooltip 已经够用，不用再手动包一层。
    expect(tips(on.tree)).toHaveLength(0);

    const off = mount(MdCapsule, { commentMode: false, canComment: true, onToggleComment: () => {} });
    expect(btn(off.tree).props.active).toBe(false);
  });
});
