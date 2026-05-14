import type { SkillMenuItem } from './skillMenuItems';

export function filterSlashItems(items: readonly SkillMenuItem[], text: string): SkillMenuItem[] {
  if (!text.startsWith('/')) return [];
  if (text.includes('\n')) return [];
  const q = text.slice(1).toLowerCase();
  if (q.length === 0) return [...items];
  return items.filter((it) => it.name.slice(1).toLowerCase().startsWith(q));
}

export type KeyAction =
  | { kind: 'send' }
  | { kind: 'newline' }
  | { kind: 'slash-up' }
  | { kind: 'slash-down' }
  | { kind: 'slash-commit' }
  | { kind: 'slash-close' }
  | { kind: 'ignore' };

export function dispatchInputKey(args: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  slashMenuOpen: boolean;
}): KeyAction {
  if (args.slashMenuOpen) {
    if (args.key === 'Enter' || args.key === 'Tab') return { kind: 'slash-commit' };
    if (args.key === 'ArrowDown') return { kind: 'slash-down' };
    if (args.key === 'ArrowUp') return { kind: 'slash-up' };
    if (args.key === 'Escape') return { kind: 'slash-close' };
    return { kind: 'ignore' };
  }
  if (args.key !== 'Enter') return { kind: 'ignore' };
  if (args.metaKey || args.ctrlKey) return { kind: 'send' };
  if (args.isComposing) return { kind: 'ignore' };
  if (args.shiftKey) return { kind: 'newline' };
  return { kind: 'send' };
}
