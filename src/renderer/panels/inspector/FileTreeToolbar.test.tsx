import { it, expect, vi } from 'vitest';
import { mount, findAllWhere } from '../../../test-support/miniReact';
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...(await import('../../../test-support/miniReact')).reactHooks }));

import { FileTreeToolbar } from './FileTreeToolbar';
import { IconButton, NavIcon } from '../../shared';
import { DropdownMenu, DropdownSection } from '../../shared/DropdownMenu';
it('sort uses the left sidebar icon trigger, shared section and checked iconized choices', () => {
  const sorts: string[] = [];
  const m = mount(FileTreeToolbar, { sortBy: 'modified' as const, onSort: (s: 'name' | 'modified') => sorts.push(s) });
  const menu = findAllWhere(m.tree, el => el.type === DropdownMenu)[0];
  let toggled = 0;
  const trigger = menu.props.trigger({ open: true, toggle: () => toggled++, ref: null });
  expect(trigger.type).toBe(IconButton); expect(trigger.props).toMatchObject({ size: 22, tone: 'faint', active: true, testId: 'file-sort-trigger' });
  expect(trigger.props.children.type).toBe(NavIcon); expect(trigger.props.children.props.name).toBe('filter');
  trigger.props.onClick(); expect(toggled).toBe(1);
  expect(findAllWhere(m.tree, el => el.type === DropdownSection && el.props.title === '排序条件')).toHaveLength(1);
  expect(m.find('file-sort-modified').props.checked).toBe(true); expect(m.find('file-sort-name').props.checked).toBe(false);
  expect(m.find('file-sort-name').props.icon.type).toBe(NavIcon); expect(m.find('file-sort-modified').props.icon.type).toBe(NavIcon);
  m.find('file-sort-name').props.onClick(); m.find('file-sort-modified').props.onClick(); expect(sorts).toEqual(['name', 'modified']);
});
