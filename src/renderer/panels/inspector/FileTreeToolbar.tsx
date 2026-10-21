import type { Ref } from 'react';
import type { FileSortBy } from './fileTreeModel';
import { IconButton, NavIcon, DropdownMenu, DropdownSection, DropdownItem } from '../../shared';

type Props = {
  sortBy: FileSortBy;
  onSort: (sortBy: FileSortBy) => void;
};

export function FileTreeToolbar({ sortBy, onSort }: Props) {
  return (
    <div
      className="flex items-center justify-between font-sans"
      onClick={e => e.stopPropagation()}
      style={{ padding: '10px 6px 8px', fontSize: 11, color: 'var(--color-ink-soft)' }}
    >
      <span
        className="font-mono uppercase"
        style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-ink-faint)', letterSpacing: 1 }}
      >文件</span>
      <DropdownMenu
        align="right"
        width={220}
        testId="file-sort-menu"
        trigger={({ open, toggle, ref }) => (
          <IconButton
            ref={ref as Ref<HTMLButtonElement>}
            size={22}
            tone="faint"
            tooltip={open ? undefined : '排序文件'}
            ariaLabel="排序文件"
            active={open}
            testId="file-sort-trigger"
            onClick={toggle}
          >
            <NavIcon name="filter" size={14} />
          </IconButton>
        )}
      >
        <DropdownSection title="排序条件">
          <DropdownItem
            icon={<NavIcon name="file-text" size={14} />}
            testId="file-sort-name"
            label="文件名"
            checked={sortBy === 'name'}
            onClick={() => onSort('name')}
          />
          <DropdownItem
            icon={<NavIcon name="pencil-line" size={14} />}
            testId="file-sort-modified"
            label="修改时间"
            checked={sortBy === 'modified'}
            onClick={() => onSort('modified')}
          />
        </DropdownSection>
      </DropdownMenu>
    </div>
  );
}
