import type { Ref } from 'react';
import type { FileSortBy } from './fileTreeModel';
import { DropdownMenu, DropdownItem } from '../../shared/DropdownMenu';

type Props = {
  sortBy: FileSortBy;
  onSort: (sortBy: FileSortBy) => void;
  selectedCount: number;
  onDelete: () => void;
  pending: boolean;
};

export function FileTreeToolbar({ sortBy, onSort, selectedCount, onDelete, pending }: Props) {
  return (
    <div
      className="flex items-center gap-2 font-sans"
      onClick={e => e.stopPropagation()}
      style={{ padding: '10px 6px 8px', fontSize: 11, color: 'var(--color-ink-soft)' }}
    >
      <span
        className="font-mono uppercase"
        style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-ink-faint)', letterSpacing: 1 }}
      >文件</span>
      <DropdownMenu
        width={150}
        trigger={({ toggle, ref }) => (
          <button ref={ref as Ref<HTMLButtonElement>} type="button" data-testid="file-sort-trigger" onClick={toggle}>
            {sortBy === 'name' ? '文件名' : '修改时间'} ▾
          </button>
        )}
      >
        <DropdownItem testId="file-sort-name" label="文件名" checked={sortBy === 'name'} onClick={() => onSort('name')} />
        <DropdownItem testId="file-sort-modified" label="修改时间" checked={sortBy === 'modified'} onClick={() => onSort('modified')} />
      </DropdownMenu>
      {selectedCount > 0 && (
        <>
          <span className="ml-auto">已选 {selectedCount}</span>
          <button type="button" data-testid="file-delete-selected" disabled={pending} onClick={onDelete}>
            {pending ? '删除中…' : '删除'}
          </button>
        </>
      )}
    </div>
  );
}
