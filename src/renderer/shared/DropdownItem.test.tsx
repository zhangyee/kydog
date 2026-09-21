import { describe, it, expect, vi } from 'vitest';
import { DropdownItem } from './DropdownMenu';
import { findByTestId, queryByTestId } from '../../test-support/miniReact';

/** 禁用项：点了不触发、也不让外层面板的 onClick（关菜单）收到；hint 顶替 shortcut 的位置。 */
describe('DropdownItem disabled / hint', () => {
  it('禁用：aria-disabled、点击不调 onClick 且拦住冒泡；同一个项不禁用时照常调', () => {
    const onClick = vi.fn();
    const stop = vi.fn();
    const off = DropdownItem({ label: '归档', disabled: true, hint: '运行中', onClick, testId: 'it' });
    expect(off.props['aria-disabled']).toBe(true);
    off.props.onClick({ stopPropagation: stop });
    expect(onClick).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);

    const on = DropdownItem({ label: '归档', onClick, testId: 'it' });
    expect(on.props['aria-disabled']).toBeUndefined();
    on.props.onClick({ stopPropagation: stop });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('hint 出现时不显示 shortcut；没有 hint 时 shortcut 回来', () => {
    const withHint = DropdownItem({ label: '归档', hint: '运行中', shortcut: '⌘E' });
    expect(findByTestId(withHint, 'dropdown-item-hint').props.children).toBe('运行中');
    expect(queryByTestId(withHint, 'dropdown-item-shortcut')).toBeNull();

    const noHint = DropdownItem({ label: '归档', shortcut: '⌘E' });
    expect(findByTestId(noHint, 'dropdown-item-shortcut').props.children).toBe('⌘E');
    expect(queryByTestId(noHint, 'dropdown-item-hint')).toBeNull();
  });
});
