import { disposeWebResearchThread } from '../webResearch/service';
vi.mock('../webResearch/service', () => ({ disposeWebResearchThread: vi.fn(async () => {}) }));
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { saveIndex, loadIndex } from '../persist/indexFile';

vi.mock('electron', () => ({ dialog: {}, shell: {} }));
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
    vi.mocked(disposeWebResearchThread).mockClear();
    await projectService.close({ projectPath: '/p1' });
    expect(vi.mocked(disposeWebResearchThread).mock.calls.map(c => c[0]).sort()).toEqual(['t1', 't3']);

    expect(vi.mocked(browserService.disposeForThread).mock.calls.map((c) => c[0]).sort()).toEqual(['t1', 't3']);
    expect((await loadIndex()).threads.map((t) => t.id)).toEqual(['t2']);
  });
});

describe('projectService.readDir', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-readdir-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('不列点号开头的与 node_modules（与 watcher 判「列表动没动」是同一个谓词）', async () => {
    writeFileSync(path.join(dir, 'a.md'), '');
    writeFileSync(path.join(dir, '.paper.pdf.json'), '');
    mkdirSync(path.join(dir, 'node_modules'));
    mkdirSync(path.join(dir, 'data'));
    const names = (await projectService.readDir({ path: dir })).map((n) => n.name);
    expect(names).toEqual(['data', 'a.md']);
  });

  it('读取这一层真实 mtime，默认顺序仍按名称而非时间', async () => {
    writeFileSync(path.join(dir, 'a.md'), 'a');
    writeFileSync(path.join(dir, 'z.pdf'), 'z');
    const aTime = new Date('2026-01-02T00:00:00Z');
    const zTime = new Date('2026-01-03T00:00:00Z');
    utimesSync(path.join(dir, 'a.md'), aTime, aTime);
    utimesSync(path.join(dir, 'z.pdf'), zTime, zTime);
    expect((await fs.stat(path.join(dir, 'z.pdf'))).mtimeMs).toBe(1767398400000);
    expect((await fs.stat(path.join(dir, 'a.md'))).mtimeMs).toBe(1767312000000);
    const nodes = await projectService.readDir({ path: dir });
    expect(nodes.map((n) => n.name)).toEqual(['a.md', 'z.pdf']);
    expect(nodes.map((n) => n.mtimeMs)).toEqual([1767312000000, 1767398400000]);
  });

  it('仅元数据 ENOENT 略过条目，EACCES 保留条目且时间为 null', async () => {
    writeFileSync(path.join(dir, 'gone.md'), 'gone');
    writeFileSync(path.join(dir, 'denied.pdf'), 'denied');
    writeFileSync(path.join(dir, 'ok.md'), 'ok');
    const before = await projectService.readDir({ path: dir });
    expect(before.map((n) => n.name)).toEqual(['denied.pdf', 'gone.md', 'ok.md']);
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementation((async (filePath: string) => {
      if (filePath === path.join(dir, 'gone.md')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      if (filePath === path.join(dir, 'denied.pdf')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return stat(filePath);
    }) as typeof fs.stat);
    const nodes = await projectService.readDir({ path: dir });
    expect(nodes.map((n) => n.name)).toEqual(['denied.pdf', 'ok.md']);
    expect(nodes[0]).toEqual({ name: 'denied.pdf', path: path.join(dir, 'denied.pdf'), kind: 'file', mtimeMs: null });
    expect(nodes[1].mtimeMs).toBe((await stat(path.join(dir, 'ok.md'))).mtimeMs);
  });

  it('读不了时错误消息带 errno：文件树原样显示，用户截图就分得清是被删了还是没权限', async () => {
    await expect(projectService.readDir({ path: path.join(dir, 'gone') })).rejects.toThrow(/\(ENOENT\)$/);
  });
});
