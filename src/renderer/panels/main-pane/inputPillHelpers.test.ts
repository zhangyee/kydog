import { describe, it, expect } from 'vitest';
import { filterSlashItems, dispatchInputKey } from './inputPillHelpers';
import { SKILL_MENU_ITEMS } from './skillMenuItems';

describe('filterSlashItems', () => {
  it('returns [] when text is empty', () => {
    expect(filterSlashItems(SKILL_MENU_ITEMS, '')).toEqual([]);
  });
  it('returns [] when text does not start with /', () => {
    expect(filterSlashItems(SKILL_MENU_ITEMS, 'hello')).toEqual([]);
  });
  it('returns [] when text contains a newline', () => {
    expect(filterSlashItems(SKILL_MENU_ITEMS, '/fr\nmore')).toEqual([]);
  });
  it('returns all items for bare "/"', () => {
    expect(filterSlashItems(SKILL_MENU_ITEMS, '/')).toHaveLength(SKILL_MENU_ITEMS.length);
  });
  it('prefix-matches against item.name without the leading slash, case-insensitive', () => {
    const r = filterSlashItems(SKILL_MENU_ITEMS, '/FR');
    expect(r.map((x) => x.name)).toEqual(['/frontier']);
  });
  it('returns [] when prefix matches nothing', () => {
    expect(filterSlashItems(SKILL_MENU_ITEMS, '/xyz')).toEqual([]);
  });
});

describe('dispatchInputKey', () => {
  const base = { shiftKey: false, metaKey: false, ctrlKey: false, isComposing: false, slashMenuOpen: false };

  it('Enter (no modifier, menu closed, not composing) -> send', () => {
    expect(dispatchInputKey({ ...base, key: 'Enter' })).toEqual({ kind: 'send' });
  });
  it('Shift+Enter -> newline', () => {
    expect(dispatchInputKey({ ...base, key: 'Enter', shiftKey: true })).toEqual({ kind: 'newline' });
  });
  it('Enter during IME composition -> ignore', () => {
    expect(dispatchInputKey({ ...base, key: 'Enter', isComposing: true })).toEqual({ kind: 'ignore' });
  });
  it('Cmd+Enter -> send (even during composition, by spec)', () => {
    expect(dispatchInputKey({ ...base, key: 'Enter', metaKey: true })).toEqual({ kind: 'send' });
    expect(dispatchInputKey({ ...base, key: 'Enter', metaKey: true, isComposing: true })).toEqual({ kind: 'send' });
  });
  it('Ctrl+Enter -> send', () => {
    expect(dispatchInputKey({ ...base, key: 'Enter', ctrlKey: true })).toEqual({ kind: 'send' });
  });
  it('non-Enter key, menu closed -> ignore', () => {
    expect(dispatchInputKey({ ...base, key: 'a' })).toEqual({ kind: 'ignore' });
  });
  it('Enter while slash menu open -> slash-commit', () => {
    expect(dispatchInputKey({ ...base, key: 'Enter', slashMenuOpen: true })).toEqual({ kind: 'slash-commit' });
  });
  it('Tab while slash menu open -> slash-commit', () => {
    expect(dispatchInputKey({ ...base, key: 'Tab', slashMenuOpen: true })).toEqual({ kind: 'slash-commit' });
  });
  it('ArrowDown while slash menu open -> slash-down', () => {
    expect(dispatchInputKey({ ...base, key: 'ArrowDown', slashMenuOpen: true })).toEqual({ kind: 'slash-down' });
  });
  it('ArrowUp while slash menu open -> slash-up', () => {
    expect(dispatchInputKey({ ...base, key: 'ArrowUp', slashMenuOpen: true })).toEqual({ kind: 'slash-up' });
  });
  it('Escape while slash menu open -> slash-close', () => {
    expect(dispatchInputKey({ ...base, key: 'Escape', slashMenuOpen: true })).toEqual({ kind: 'slash-close' });
  });
  it('Escape while slash menu closed -> ignore', () => {
    expect(dispatchInputKey({ ...base, key: 'Escape' })).toEqual({ kind: 'ignore' });
  });
  it('Shift+Enter while slash menu open -> still slash-commit (menu wins)', () => {
    expect(dispatchInputKey({ ...base, key: 'Enter', shiftKey: true, slashMenuOpen: true }))
      .toEqual({ kind: 'slash-commit' });
  });
});
