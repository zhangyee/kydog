import { describe, it, expect } from 'vitest';
import { filterSkillEntries, dispatchInputKey } from './inputPillHelpers';
import type { SkillEntry } from '../../../shared/types';

const SKILLS: SkillEntry[] = [
  { name: 'brainstorming', description: 'help turn ideas into designs', origin: 'builtin', enabled: true, dirPath: '/x/brainstorming' },
  { name: 'frontier', description: 'find latest papers', origin: 'user', enabled: true, dirPath: '/x/frontier' },
  { name: 'fastpaper', description: 'paper helpers', origin: 'builtin', enabled: true, dirPath: '/x/fastpaper' },
];

describe('filterSkillEntries', () => {
  it('returns [] when text is empty', () => {
    expect(filterSkillEntries(SKILLS, '')).toEqual([]);
  });
  it('returns [] when text does not start with /', () => {
    expect(filterSkillEntries(SKILLS, 'hello')).toEqual([]);
  });
  it('returns [] when text contains a newline', () => {
    expect(filterSkillEntries(SKILLS, '/fr\nmore')).toEqual([]);
  });
  it('returns all items for bare "/"', () => {
    expect(filterSkillEntries(SKILLS, '/')).toHaveLength(SKILLS.length);
  });
  it('prefix-matches against item.name (no leading /), case-insensitive', () => {
    const r = filterSkillEntries(SKILLS, '/FR');
    expect(r.map((x) => x.name)).toEqual(['frontier']);
  });
  it('returns multiple matches sorted by store order', () => {
    const r = filterSkillEntries(SKILLS, '/f');
    expect(r.map((x) => x.name)).toEqual(['frontier', 'fastpaper']);
  });
  it('returns [] when prefix matches nothing', () => {
    expect(filterSkillEntries(SKILLS, '/xyz')).toEqual([]);
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
