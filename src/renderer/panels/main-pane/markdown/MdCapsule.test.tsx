import { describe, it, expect, vi } from 'vitest';
import { findAllWhere, mount } from '../../../../test-support/miniReact';

vi.mock('react', async (importOriginal) => {
  const real = await importOriginal<typeof import('react')>();
  const mini = await import('../../../../test-support/miniReact');
  return { ...real, ...mini.reactHooks } as unknown as typeof real;
});

const { MdCapsule } = await import('./MdCapsule');
const { IconButton } = await import('../../../shared');

describe('MdCapsule', () => {
  const btn = (tree: unknown) => findAllWhere(tree as never, (el) => el.type === IconButton)[0];
  it('有对话：可点、tooltip「评论模式」、active 跟着模式；没对话：禁用、tooltip「先打开一个对话」', () => {
    const on = mount(MdCapsule, { commentMode: true, canComment: true, onToggleComment: () => {} });
    expect(btn(on.tree).props).toMatchObject({ disabled: false, tooltip: '评论模式', active: true });
    expect(on.find('md-capsule').props['data-comment-mode']).toBe('on');
    const off = mount(MdCapsule, { commentMode: false, canComment: true, onToggleComment: () => {} });
    expect(btn(off.tree).props.active).toBe(false);
    const none = mount(MdCapsule, { commentMode: false, canComment: false, onToggleComment: () => {} });
    expect(btn(none.tree).props).toMatchObject({ disabled: true, tooltip: '先打开一个对话' });
  });
});
