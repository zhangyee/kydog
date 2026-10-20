import { afterEach, beforeEach, expect, it } from 'vitest';
import { deleteProjectFiles } from './fileActions';
import { useUiStore } from '../../stores/uiStore';
import { useConfirmStore } from '../../stores/confirmStore';
import type { TrashFilesResult } from '../../../shared/files';

const a = 'C:\\p\\a.md', b = 'C:\\p\\nested\\b.markdown';
let requests: unknown[];
let reads: unknown[];
let result: TrashFilesResult;
beforeEach(() => {
  useUiStore.setState(useUiStore.getInitialState());
  requests = []; reads = [];
  result = { trashed: [a, b], failed: [] };
  Object.assign(globalThis, { window: { kydog: { invoke: async (method: string, args: unknown) => {
    if (method === 'file.trash') { requests.push(args); return result; }
    if (method === 'project.readDir') { reads.push(args); return []; }
    throw new Error(method);
  } } } });
});
afterEach(() => { useConfirmStore.getState().resolve(false); delete (globalThis as Record<string, unknown>).window; });
const prepare = () => {
  const s = useUiStore.getState(); s.openFile(b); s.openFile(a);
  s.setFileTabStatus(b, { status: 'ready', diskContent: 'failed original' }); s.setFileTabDirty(b, true);
  s.setFileTabStatus(a, { status: 'ready', diskContent: 'original' }); s.setFileTabDirty(a, true);
};
const targets = [{ path: a, parentPath: 'C:\\p' }, { path: b, parentPath: 'C:\\p\\nested' }];
it('real confirmation approves exact snapshot, closes successes, refreshes captured parents; cancellation retains dirty data', async () => {
  prepare();
  expect(useUiStore.getState().openFileTabs.map(t => t.path)).toEqual([b, a]);
  const first = deleteProjectFiles('C:\\p', [...targets, targets[0]]);
  expect(useConfirmStore.getState().request?.message).toContain('a.md');
  expect(useConfirmStore.getState().request?.message).toContain('未保存修改将丢失');
  useConfirmStore.getState().resolve(true); await first;
  expect(requests).toEqual([{ projectPath: 'C:\\p', paths: [a, b] }]);
  expect(useUiStore.getState().openFileTabs).toEqual([]);
  expect(reads).toEqual([{ path: 'C:\\p' }, { path: 'C:\\p\\nested' }]);
  prepare();
  expect(useUiStore.getState().openFileTabs.map(t => t.path)).toEqual([b, a]);
  const second = deleteProjectFiles('C:\\p', targets);
  useConfirmStore.getState().resolve(false);
  expect(await second).toBeNull();
  expect(requests).toHaveLength(1);
  expect(useUiStore.getState().openFileTabs.find(t => t.path === a)).toMatchObject({ dirty: true, diskContent: 'original' });
});
it.each([a, b])('partial response preserves failed draft when active=%s and refreshes only successful parents', async (active) => {
  prepare(); useUiStore.getState().focusFileTab(active);
  result = { trashed: [a], failed: [{ path: b, error: { code: 'fs.access_denied', message: 'EPERM test' } }] };
  const p = deleteProjectFiles('C:\\p', targets); useConfirmStore.getState().resolve(true);
  expect(await p).toEqual(result);
  expect(useUiStore.getState().openFileTabs.map(t => t.path)).toEqual([b]);
  expect(useUiStore.getState().openFileTabs[0]).toMatchObject({ path: b, diskContent: 'failed original', dirty: true });
  expect(reads).toEqual([{ path: 'C:\\p' }]);
});
