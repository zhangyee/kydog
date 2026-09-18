import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { saveIndex, loadIndex } from '../persist/indexFile';

vi.mock('electron', () => ({ dialog: {}, shell: {} }));
vi.mock('./fileWatcher', () => ({ fileWatcherService: { start: vi.fn(), stop: vi.fn() } }));
vi.mock('../browser/browserService', () => ({ browserService: { disposeForThread: vi.fn() } }));

import { projectService } from './projectService';
import { browserService } from '../browser/browserService';

/**
 * 关项目会把它的对话从索引里一起摘掉 —— 那些对话名下的 agent 标签也得一起关
 * （标签跟对话走，spec 2026-09-17-browser-tab-lifecycle-design §2）。不关的话它们没有主人，
 * 只能等上限把它们一个个挤掉。
 */
describe('projectService.close 关掉被带走的对话的标签', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-proj-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'INDEX_FILE', 'get').mockReturnValue(path.join(dir, 'index.json'));
    const now = new Date().toISOString();
    await saveIndex({
      schemaVersion: 1,
      projects: [{ path: '/p1', addedAt: now }, { path: '/p2', addedAt: now }],
      threads: [
        { id: 't1', projectPath: '/p1', title: 'a', createdAt: now, lastActiveAt: now },
        { id: 't2', projectPath: '/p2', title: 'b', createdAt: now, lastActiveAt: now },
        { id: 't3', projectPath: '/p1', title: 'c', createdAt: now, lastActiveAt: now },
      ],
    });
    vi.mocked(browserService.disposeForThread).mockClear();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('只关这个项目的对话的标签，别的项目的不碰', async () => {
    await projectService.close({ projectPath: '/p1' });

    expect(vi.mocked(browserService.disposeForThread).mock.calls.map((c) => c[0]).sort()).toEqual(['t1', 't3']);
    expect((await loadIndex()).threads.map((t) => t.id)).toEqual(['t2']);
  });
});
