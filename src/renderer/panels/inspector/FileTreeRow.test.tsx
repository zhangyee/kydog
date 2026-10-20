import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mount } from '../../../test-support/miniReact';
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), ...(await import('../../../test-support/miniReact')).reactHooks }));

vi.mock('../../stores/uiStore', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../stores/uiStore')>();
  const real = mod.useUiStore;
  const hook = ((sel?: (s: unknown) => unknown) => (sel ? sel(real.getState()) : real.getState())) as unknown as typeof real;
  Object.assign(hook, real);
  return { ...mod, useUiStore: hook };
});

import { FileTreeRow } from './FileTreeRow';
import { useUiStore } from '../../stores/uiStore';
beforeEach(() => useUiStore.setState(useUiStore.getInitialState()));
afterEach(() => { delete (globalThis as Record<string, unknown>).window; });
it('double click still opens md, pdf and html; selection receives modifiers with text selection prevented', () => {
  const selected: unknown[] = [];
  for (const ext of ['md', 'pdf', 'html']) {
    const path = `/p/a.${ext}`;
    const m = mount(FileTreeRow, { node: { path, name: `a.${ext}`, kind: 'file' as const, mtimeMs: 50 }, depth: 2, selected: false, onSelect: (e: unknown) => selected.push(e), onContextMenu: () => {} });
    const event = { ctrlKey: true, metaKey: false, shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: { closest: () => ({ focus: () => {} }) } };
    m.find(`fs-${path}`).props.onMouseDown(event); expect(event.preventDefault).toHaveBeenCalled();
    m.find(`fs-${path}`).props.onClick(event); expect(selected.at(-1)).toBe(event); expect(event.preventDefault).toHaveBeenCalled();
    m.find(`fs-${path}`).props.onDoubleClick(); expect(useUiStore.getState().activeFileTabId).toBe(path);
  }
  expect(useUiStore.getState().openFileTabs.map(t => t.kind)).toEqual(['md', 'pdf', 'html']);
});
it('expanded directory read failure waits for explicit retry and then recovers through real loadDir', async () => {
  const props = { node: { path: '/p/sub', name: 'sub', kind: 'dir' as const, mtimeMs: null }, depth: 0, selected: false, onSelect: () => {}, onContextMenu: () => {} };
  let reads = 0, failure = true;
  Object.assign(globalThis, { window: { kydog: { invoke: async (method: string, args: unknown) => {
    expect(method).toBe('project.readDir'); expect(args).toEqual({ path: '/p/sub' }); reads++;
    if (failure) throw new Error('EACCES sub');
    return [{ path: '/p/sub/a.md', name: 'a.md', kind: 'file', mtimeMs: 50 }];
  } } } });
  useUiStore.getState().toggleDir('/p/sub');
  const m = mount(FileTreeRow, props); await m.settle(); m.rerender(props);
  expect(useUiStore.getState().dirErrors['/p/sub']).toBe('EACCES sub');
  await m.settle(); m.rerender(props); expect(reads).toBe(1);
  failure = false; useUiStore.getState().retryDir('/p/sub'); m.rerender(props); await m.settle(); m.rerender(props);
  expect(reads).toBe(2); expect(useUiStore.getState().dirCache['/p/sub']).toEqual([{ path: '/p/sub/a.md', name: 'a.md', kind: 'file', mtimeMs: 50 }]);
  expect(useUiStore.getState().dirErrors['/p/sub']).toBeUndefined();
});
