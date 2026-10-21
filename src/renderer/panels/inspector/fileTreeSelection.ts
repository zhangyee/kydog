import { isTrashablePath } from '../../../shared/files';

export type FileSelection = { selectedPaths: string[]; anchorPath: string | null };

export function effectiveFileSelection(s: FileSelection, order: readonly string[]): string[] {
  const selected = new Set(s.selectedPaths);
  return order.filter(path => isTrashablePath(path) && selected.has(path));
}

export function selectFile(s: FileSelection, input: { path: string; shift: boolean; toggle: boolean }, order: readonly string[]): FileSelection {
  const visible = order.filter(isTrashablePath);
  if (!visible.includes(input.path)) return s;
  const anchor = s.anchorPath === null ? -1 : visible.indexOf(s.anchorPath);
  if (input.shift && anchor !== -1) {
    const end = visible.indexOf(input.path);
    return { selectedPaths: visible.slice(Math.min(anchor, end), Math.max(anchor, end) + 1), anchorPath: s.anchorPath };
  }
  const selected = effectiveFileSelection(s, order);
  return {
    selectedPaths: input.toggle ? selected.includes(input.path) ? selected.filter(path => path !== input.path) : [...selected, input.path] : [input.path],
    anchorPath: input.path,
  };
}

/** Same platform contract as ThreadRow: macOS Ctrl-click belongs to its context menu. */
export function isFileSelectionToggle(input: { ctrlKey: boolean; metaKey: boolean }, platform: string): boolean {
  return platform === 'darwin' ? input.metaKey : input.ctrlKey;
}
