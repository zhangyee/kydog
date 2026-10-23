import { disposeWebResearchThread } from '../webResearch/service';
vi.mock('../webResearch/service', () => ({ disposeWebResearchThread: vi.fn(async () => {}) }));
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { saveIndex, loadIndex } from '../persist/indexFile';

vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() }, shell: {} }));
vi.mock('../browser/browserService', () => ({ browserService: { disposeForThread: vi.fn() } }));

import { projectService, ProjectService } from './projectService';
import { dialog } from 'electron';
import { browserService } from '../browser/browserService';

describe('单项目模式', () => {
  let dir: string;
  let target: string;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-single-'));
    target = path.join(dir, 'debug');
    mkdirSync(target);
    vi.spyOn(paths, 'INDEX_FILE', 'get').mockReturnValue(path.join(dir, 'index.json'));
    await saveIndex({ schemaVersion: 1, projects: [{ path: '/other', addedAt: 'old', pinned: true }],
      threads: [{ id: 'other-thread', projectPath: '/other', title: 'kept', createdAt: 'old', lastActiveAt: 'old' }] });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('临时目标不登记到普通列表，关闭模式后恢复原项目与对话', async () => {
    const normal = new ProjectService();
    expect((await normal.list()).map(p => p.path)).toEqual(['/other']);
    const before = readFileSync(path.join(dir, 'index.json'), 'utf8');
    const scoped = new ProjectService({ singleProjectPath: target });
    const [project] = await scoped.list();
    expect(project.path).toBe(target);
    expect(await scoped.list()).toEqual([project]);
    const index = await loadIndex();
    expect(index.projects.map(p => p.path)).toEqual(['/other']);
    expect(index.projects[0]).toEqual({ path: '/other', addedAt: 'old', pinned: true });
    expect(index.threads.map(t => t.id)).toEqual(['other-thread']);
    expect((await normal.list()).map(p => p.path)).toEqual(['/other']);
    expect(readFileSync(path.join(dir, 'index.json'), 'utf8')).toBe(before);
  });

  it.each([true, false])('原已登记的目标保留元数据、顺序与正常项目身份，pinned=%s', async pinned => {
    const index = await loadIndex();
    const existing = { path: target, addedAt: 'original', label: '原项目', pinned };
    index.projects.unshift(existing);
    await saveIndex(index);
    const scoped = new ProjectService({ singleProjectPath: target });
    expect(await scoped.list()).toEqual([existing]);
    expect(await new ProjectService().list()).toEqual([existing, { path: '/other', addedAt: 'old', pinned: true }]);
    expect(await loadIndex()).toEqual(index);
  });

  it('临时项目改名与置顶只影响本次运行，普通项目更新仍落盘', async () => {
    const normal = new ProjectService();
    await normal.update({ projectPath: '/other', label: '正常更新', pinned: false });
    expect((await loadIndex()).projects[0]).toMatchObject({ label: '正常更新', pinned: false });
    const before = await loadIndex();
    const scoped = new ProjectService({ singleProjectPath: target });
    expect((await scoped.list())[0].path).toBe(target);
    expect(await scoped.update({ projectPath: target, label: '临时更新', pinned: true }))
      .toMatchObject({ path: target, label: '临时更新', pinned: true });
    expect((await scoped.list())[0]).toMatchObject({ path: target, label: '临时更新', pinned: true });
    expect(await loadIndex()).toEqual(before);
    expect((await new ProjectService({ singleProjectPath: target }).list())[0])
      .toEqual({ path: target, addedAt: expect.any(String) });
  });

  it('开启期间拒绝打开和移除项目，并保持索引不变', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [target] });
    expect((await new ProjectService().open()).path).toBe(target);
    const before = await loadIndex();
    const scoped = new ProjectService({ singleProjectPath: target });
    await expect(scoped.open()).rejects.toMatchObject({ code: 'project.single_project_locked' });
    await expect(scoped.close({ projectPath: target })).rejects.toMatchObject({ code: 'project.single_project_locked' });
    expect(await loadIndex()).toEqual(before);
  });

  it('启动时固定目标，之后修改配置对象不改变本次项目范围', async () => {
    const config = { singleProject: { enabled: true, path: target } };
    const service = new ProjectService();
    await service.initialize(config);
    config.singleProject.enabled = false;
    config.singleProject.path = '/other';
    expect(service.singleProjectPath).toBe(target);
    expect((await service.list()).map(p => p.path)).toEqual([target]);
    const restarted = new ProjectService();
    await restarted.initialize(config);
    expect((await restarted.list()).map(p => p.path)).toEqual(['/other']);
  });

  it.each(['', 'relative/path', 'missing', 'file'])('启动拒绝无效目标 %s，不修改原索引', async (input) => {
    writeFileSync(path.join(dir, 'file'), 'not a directory');
    const candidate = input === 'missing' || input === 'file' ? path.join(dir, input) : input;
    const before = await loadIndex();
    const service = new ProjectService();
    await expect(service.initialize({ singleProject: { enabled: true, path: candidate } }))
      .rejects.toMatchObject({ code: 'settings.invalid' });
    expect(await loadIndex()).toEqual(before);
  });

  it.each(['{broken', '{"schemaVersion":999,"projects":[],"threads":[]}'])(
    '启动临时项目时索引不可读应报错，不能拿空索引覆盖原件：%s', async raw => {
      const file = path.join(dir, 'index.json');
      writeFileSync(file, raw);
      await expect(new ProjectService().initialize({ singleProject: { enabled: true, path: target } }))
        .rejects.toMatchObject({ code: 'fs.read_failed' });
      expect(readFileSync(file, 'utf8')).toBe(raw);
    },
  );
});

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
