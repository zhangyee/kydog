import { it, expect, vi } from 'vitest';
import { mount, findAllWhere } from '../../../test-support/miniReact';
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...(await import('../../../test-support/miniReact')).reactHooks }));

import { FileTreeToolbar } from './FileTreeToolbar';
import { DropdownMenu } from '../../shared/DropdownMenu';
it('sort controls send preference, selection count exposes deletion and pending disables it', () => {
  const sorts: string[] = []; let deletes = 0;
  const props = { sortBy: 'modified' as const, onSort: (s: 'name' | 'modified') => sorts.push(s), selectedCount: 2, onDelete: () => deletes++, pending: false };
  const m = mount(FileTreeToolbar, props);
  m.find('file-sort-name').props.onClick(); m.find('file-sort-modified').props.onClick();
  expect(sorts).toEqual(['name', 'modified']);
  expect(findAllWhere(m.tree, el => el.type === DropdownMenu)).toHaveLength(1);
  m.find('file-delete-selected').props.onClick(); expect(deletes).toBe(1);
  expect(m.find('file-delete-selected').props.disabled).toBe(false);
  m.rerender({ ...props, pending: true }); expect(m.find('file-delete-selected').props.disabled).toBe(true);
  m.rerender({ ...props, selectedCount: 0 }); expect(m.query('file-delete-selected')).toBeNull();
});
