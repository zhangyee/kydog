import { describe, it, expect } from 'vitest';
import { findOneWhere, mount } from '../../test-support/miniReact';
import type { IconButtonProps } from './IconButton';

const { IconButton } = await import('./IconButton');

// IconButton 是 forwardRef 且不用任何 hook——不用走 miniReact 的 vi.mock('react') 那条路
// （那套只替身 hook），直接拿 .render 当普通函数渲染就够（forwardRef(fn) 的 `.render` 就是 fn
// 本身；公开类型 ForwardRefExoticComponent 上没有 .render，这里 cast 一下取运行时的真值）。
const iconButtonRender = (IconButton as unknown as {
  render: (props: IconButtonProps, ref: null) => unknown;
}).render;
const renderIconButton = (props: IconButtonProps) => iconButtonRender(props, null);

describe('IconButton', () => {
  const btn = (tree: unknown) => findOneWhere(tree as never, (el) => el.type === 'button');

  it('activeVariant="accent" 时背景走 --color-accent-soft、图标色走 --color-accent；不传（默认 subtle）保持老样子的淡背景', () => {
    // 正向先来：证明换 activeVariant 这个 prop，渲染出来的行内样式真的会变——
    // 免得下面「默认值等于 subtle」的断言只是巧合撞对了值（CLAUDE.md「翻一遍面」的要求）。
    const accent = mount(renderIconButton, { active: true, activeVariant: 'accent', tone: 'ink', children: null });
    expect(btn(accent.tree).props.style).toMatchObject({
      background: 'var(--color-accent-soft)',
      color: 'var(--color-accent)',
    });

    const subtleExplicit = mount(renderIconButton, { active: true, activeVariant: 'subtle', tone: 'ink', children: null });
    expect(btn(subtleExplicit.tree).props.style).toMatchObject({
      background: 'var(--color-hover-bg)',
      color: 'var(--color-ink)',
    });

    // 不传 activeVariant：默认值必须是 'subtle'，不能悄悄换成 'accent'——PDF 胶囊等既有调用方
    // 一个字没改，默认值一变它们的外观就跟着变。
    const defaulted = mount(renderIconButton, { active: true, tone: 'ink', children: null });
    expect(btn(defaulted.tree).props.style).toMatchObject({
      background: 'var(--color-hover-bg)',
      color: 'var(--color-ink)',
    });
  });

  it('activeVariant="accent" 但 active=false：不显强调色——accentActive 要求两者同时成立', () => {
    // 正向先证明：同一份 props，active:true 时确实显 accent 背景（上一条用例已经证明过，这里
    // 再原地翻一次面，紧挨着下面的负向断言，免得「找不到」被当成「关着就是没有」）。
    const on = mount(renderIconButton, { active: true, activeVariant: 'accent', children: null });
    expect(btn(on.tree).props.style.background).toBe('var(--color-accent-soft)');

    const off = mount(renderIconButton, { active: false, activeVariant: 'accent', children: null });
    expect(btn(off.tree).props.style.background).toBe('transparent');
    expect(btn(off.tree).props.style.background).not.toBe('var(--color-accent-soft)');
  });
});
