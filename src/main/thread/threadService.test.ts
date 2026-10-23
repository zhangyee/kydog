import { disposeWebResearchThread } from '../webResearch/service';
vi.mock('../webResearch/service', () => ({ disposeWebResearchThread: vi.fn(async () => {}) }));
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { saveIndex, loadIndex } from '../persist/indexFile';
import { threadService, ThreadService } from './threadService';
import { agentService } from '../agent/AgentService';
import { encodeUserTurn, refTag } from '../../shared/userTurn';
import { researchRunStore } from '../webResearch/runStore';
import { xResearchTaskStore } from '../x/xResearchTaskStore';

describe('单项目对话范围', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-thread-scope-'));
    vi.spyOn(paths, 'INDEX_FILE', 'get').mockReturnValue(path.join(dir, 'index.json'));
    await saveIndex({ schemaVersion: 1,
      projects: [{ path: '/a', addedAt: 'old' }, { path: '/debug', addedAt: 'new' }],
      threads: [
        { id: 'a', projectPath: '/a', title: 'other', createdAt: 'old', lastActiveAt: 'old' },
        { id: 'debug', projectPath: '/debug', title: 'target', createdAt: 'new', lastActiveAt: 'new' },
      ] });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('列表只返回目标对话，完整索引不变；关闭模式重新得到全部对话', async () => {
    const normal = new ThreadService();
    expect((await normal.listAll()).map(t => t.id)).toEqual(['a', 'debug']);
    const before = await loadIndex();
    const scoped = new ThreadService({ singleProjectPath: '/debug' });
    expect((await scoped.listAll()).map(t => t.id)).toEqual(['debug']);
    expect((await normal.list({ projectPath: '/a' })).map(t => t.id)).toEqual(['a']);
    expect(await scoped.list({ projectPath: '/a' })).toEqual([]);
    expect((await scoped.list({ projectPath: '/debug' })).map(t => t.id)).toEqual(['debug']);
    expect(await loadIndex()).toEqual(before);
    expect((await normal.listAll()).map(t => t.id)).toEqual(['a', 'debug']);
  });

  it('允许目标内新建，拒绝在其他项目新建或把目标对话移到其他项目', async () => {
    vi.mocked(agentService.loadHistory).mockResolvedValue([]);
    const scoped = new ThreadService({ singleProjectPath: '/debug' });
    expect((await scoped.create({ projectPath: '/debug' })).projectPath).toBe('/debug');
    const before = await loadIndex();
    await expect(scoped.create({ projectPath: '/a' })).rejects.toMatchObject({ code: 'project.single_project_locked' });
    await expect(scoped.update({ threadId: 'debug', projectPath: '/a' }))
      .rejects.toMatchObject({ code: 'project.single_project_locked' });
    expect(await loadIndex()).toEqual(before);
  });

  it('未登记的调试项目对话在 on 可见、off 隐藏、再次 on 恢复，记录不删除', async () => {
    const index = await loadIndex();
    index.projects = index.projects.filter(p => p.path === '/a');
    await saveIndex(index);
    const scoped = new ThreadService({ singleProjectPath: '/debug' });
    expect((await scoped.listAll()).map(t => t.id)).toEqual(['debug']);
    expect((await scoped.list({ projectPath: '/debug' })).map(t => t.id)).toEqual(['debug']);
    const normal = new ThreadService({ singleProjectPath: null });
    expect((await normal.listAll()).map(t => t.id)).toEqual(['a']);
    expect(await normal.list({ projectPath: '/debug' })).toEqual([]);
    expect(await loadIndex()).toEqual(index);
    expect((await new ThreadService({ singleProjectPath: '/debug' }).listAll()).map(t => t.id)).toEqual(['debug']);
  });

  it('临时项目可新建并保存对话，不登记项目，off 后隐藏新旧调试对话', async () => {
    const index = await loadIndex();
    index.projects = index.projects.filter(p => p.path === '/a');
    await saveIndex(index);
    const scoped = new ThreadService({ singleProjectPath: '/debug' });
    const created = await scoped.create({ projectPath: '/debug', title: '临时项目对话' });
    expect(created).toMatchObject({ projectPath: '/debug', title: '临时项目对话' });
    expect((await scoped.listAll()).map(t => t.id)).toEqual(['debug', created.id]);
    expect((await loadIndex()).projects).toEqual([{ path: '/a', addedAt: 'old' }]);
    expect((await loadIndex()).threads.map(t => t.id)).toEqual(['a', 'debug', created.id]);
    expect((await new ThreadService({ singleProjectPath: null }).listAll()).map(t => t.id)).toEqual(['a']);
    expect((await new ThreadService({ singleProjectPath: '/debug' }).listAll()).map(t => t.id)).toEqual(['debug', created.id]);
  });

  it.each(['invalid-json', 'unsupported-version', 'read-error'])(
    '临时项目新建对话拒绝运行中索引故障且保留原件：%s', async failure => {
      const index = await loadIndex();
      index.projects = index.projects.filter(p => p.path === '/a');
      await saveIndex(index);
      const scoped = new ThreadService({ singleProjectPath: '/debug' });
      const control = await scoped.create({ projectPath: '/debug', title: '成功对照' });
      expect((await loadIndex()).threads.map(t => t.id)).toEqual(['a', 'debug', control.id]);
      const file = path.join(dir, 'index.json');
      if (failure === 'invalid-json') writeFileSync(file, '{broken');
      if (failure === 'unsupported-version') {
        writeFileSync(file, JSON.stringify({ ...await loadIndex(), schemaVersion: 999 }));
      }
      const before = readFileSync(file, 'utf8');
      if (failure === 'read-error') {
        vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
      }
      await expect(scoped.create({ projectPath: '/debug' })).rejects.toMatchObject({ code: 'fs.read_failed' });
      expect(readFileSync(file, 'utf8')).toBe(before);
    },
  );
});

vi.mock('../webResearch/runStore', () => ({
  researchRunStore: { removeRunsForThread: vi.fn().mockResolvedValue(undefined) },
}));

// 任务目录跟对话走（`xResearchTaskStore.removeThread`）：这里只钉「删对话真的调了它」，
// 目录本身归 `xResearchTaskStore.test.ts`。用例里的 thread id 是 `a`/`b` 这种短名，不是 UUID —
// 真 store 会按穿越防线拒掉它们，所以这一层必须是替身。
vi.mock('../x/xResearchTaskStore', () => ({
  xResearchTaskStore: { removeThread: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('./titleService', () => ({
  titleService: { generateForThread: vi.fn() },
}));
import { titleService } from './titleService';

vi.mock('../browser/browserService', () => ({
  browserService: { disposeForThread: vi.fn() },
}));
import { browserService } from '../browser/browserService';

vi.mock('../agent/AgentService', () => ({
  agentService: {
    send: vi.fn().mockResolvedValue({ runId: 'r1' }),
    loadHistory: vi.fn().mockResolvedValue([]),
    dispose: vi.fn(),
    beginThreadDeletion: vi.fn(() => ({ commit: vi.fn(), finish: vi.fn() })),
    hasActiveRunFor: vi.fn(() => false),
  },
}));

describe('threadService.update modelOverride', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-thr-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'INDEX_FILE', 'get').mockReturnValue(path.join(dir, 'index.json'));
    await saveIndex({
      schemaVersion: 1,
      projects: [{ path: '/x', addedAt: new Date().toISOString() }],
      threads: [],
    });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('设置 + 清空 + 重设', async () => {
    const t = await threadService.create({ projectPath: '/x', title: 'a' });
    await threadService.update({ threadId: t.id, modelOverride: { providerId: 'openai', modelId: 'gpt-4o' } });
    let got = (await threadService.listAll()).find((x) => x.id === t.id)!;
    expect(got.modelOverride).toEqual({ providerId: 'openai', modelId: 'gpt-4o' });

    await threadService.update({ threadId: t.id, modelOverride: null });
    got = (await threadService.listAll()).find((x) => x.id === t.id)!;
    expect(got.modelOverride).toBeUndefined();
  });

  it('同时新建多条对话时，索引保留每一条', async () => {
    const created = await Promise.all(Array.from({ length: 12 }, () => threadService.create({ projectPath: '/x' })));
    const ids = new Set((await threadService.listAll()).map((t) => t.id));
    expect(ids.size).toBe(created.length);
    for (const t of created) expect(ids.has(t.id)).toBe(true);
  });
});

describe('threadService.update projectPath', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-thr-pp-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'INDEX_FILE', 'get').mockReturnValue(path.join(dir, 'index.json'));
    await saveIndex({
      schemaVersion: 1,
      projects: [
        { path: '/a', addedAt: new Date().toISOString() },
        { path: '/b', addedAt: new Date().toISOString() },
      ],
      threads: [],
    });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('switches projectPath on empty thread', async () => {
    vi.spyOn(agentService, 'loadHistory').mockResolvedValue([]);
    const t = await threadService.create({ projectPath: '/a' });
    const updated = await threadService.update({ threadId: t.id, projectPath: '/b' });
    expect(updated.projectPath).toBe('/b');
    const got = (await threadService.listAll()).find((x) => x.id === t.id)!;
    expect(got.projectPath).toBe('/b');
  });

  it('换项目后拆掉这条对话缓存的 session；不换项目的更新不拆', async () => {
    // session 的 cwd 与 transcript 目录在建的那一刻定死，只改 index 的话，缓存里那份仍按旧项目跑。
    vi.spyOn(agentService, 'loadHistory').mockResolvedValue([]);
    vi.mocked(agentService.dispose).mockClear();
    const t = await threadService.create({ projectPath: '/a' });
    await threadService.update({ threadId: t.id, projectPath: '/b' });
    expect(vi.mocked(agentService.dispose).mock.calls).toEqual([[t.id]]);

    vi.mocked(agentService.dispose).mockClear();
    await threadService.update({ threadId: t.id, title: 'x' });
    await threadService.update({ threadId: t.id, projectPath: '/b' });
    expect(vi.mocked(agentService.dispose)).not.toHaveBeenCalled();
  });

  it('rejects switch when thread has messages', async () => {
    vi.spyOn(agentService, 'loadHistory').mockResolvedValue([
      { id: 'm1', role: 'user', content: 'x', createdAt: new Date().toISOString() },
    ]);
    const t = await threadService.create({ projectPath: '/a' });
    await expect(
      threadService.update({ threadId: t.id, projectPath: '/b' }),
    ).rejects.toMatchObject({ code: 'thread.has_messages' });
  });

  it('rejects switch when target project not opened', async () => {
    vi.spyOn(agentService, 'loadHistory').mockResolvedValue([]);
    const t = await threadService.create({ projectPath: '/a' });
    await expect(
      threadService.update({ threadId: t.id, projectPath: '/does-not-exist' }),
    ).rejects.toMatchObject({ code: 'project.not_found' });
  });
});

describe('threadService.send → titleService trigger', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-thr-'));
    mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'INDEX_FILE', 'get').mockReturnValue(path.join(dir, 'index.json'));
    await saveIndex({
      schemaVersion: 1,
      projects: [{ path: '/p', addedAt: new Date().toISOString() }],
      threads: [],
    });
    (titleService.generateForThread as any).mockClear();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('fires titleService.generateForThread on send when thread has placeholder title', async () => {
    const t = await threadService.create({ projectPath: '/p' });
    expect(t.title).toBe('无标题');
    await threadService.send({ threadId: t.id, content: 'Hi there' });
    expect(titleService.generateForThread).toHaveBeenCalledTimes(1);
    expect(titleService.generateForThread).toHaveBeenCalledWith(t.id, 'Hi there');
  });

  it('交给起标题的是纯文字：只有批注 / 只有附件的消息给引文 / 附件名，不是 <kydog- 开头的原文；发给 agent 的照旧是原文（F6）', async () => {
    const t = await threadService.create({ projectPath: '/p' });
    const commentOnly = encodeUserTurn({ body: '', attachments: [], comments: [{ file: 'ch3.md', section: '3.2 偏好对齐', quote: '将 β 固定为 0.1', note: '取值依据？' }] }).text;
    const imageOnly = encodeUserTurn({ body: '', attachments: [{ kind: 'image', name: '截图 1', data: 'AAAA', mimeType: 'image/png' }], comments: [] });
    const withRef = `对比 ${refTag('refs/dpo-2023.pdf')} 的表 2`;
    // 正向：原文确实以标签开头 —— 下面「不是 <kydog- 开头」才有意义。
    expect(commentOnly.startsWith('<kydog-comment')).toBe(true);
    expect(imageOnly.text.startsWith('<kydog-attachments>')).toBe(true);

    await threadService.send({ threadId: t.id, content: commentOnly });
    expect(titleService.generateForThread).toHaveBeenLastCalledWith(t.id, '将 β 固定为 0.1');
    expect(agentService.send).toHaveBeenLastCalledWith(t.id, '/p', commentOnly, []);

    await threadService.send({ threadId: t.id, content: imageOnly.text, images: imageOnly.images });
    expect(titleService.generateForThread).toHaveBeenLastCalledWith(t.id, '截图 1');
    expect(agentService.send).toHaveBeenLastCalledWith(t.id, '/p', imageOnly.text, imageOnly.images);

    await threadService.send({ threadId: t.id, content: withRef });
    expect(titleService.generateForThread).toHaveBeenLastCalledWith(t.id, '对比 dpo-2023.pdf 的表 2');

    for (const [, source] of (titleService.generateForThread as any).mock.calls as Array<[string, string]>) {
      expect(source.startsWith('<kydog-')).toBe(false);
    }
  });

  it('does not fire when thread already has a non-placeholder title', async () => {
    const t = await threadService.create({ projectPath: '/p', title: 'Pre-named' });
    await threadService.send({ threadId: t.id, content: 'Hi there' });
    expect(titleService.generateForThread).not.toHaveBeenCalled();
  });
});

/**
 * 对话没了，它名下的 agent 标签一起关（spec 2026-09-17-browser-tab-lifecycle-design §2）。
 * 标签跟对话走之后，这是 agent 标签除「到上限被挤掉」之外唯一的关闭时机。
 */
describe('threadService.delete 关掉这个对话的浏览器标签', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-thr-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'INDEX_FILE', 'get').mockReturnValue(path.join(dir, 'index.json'));
    await saveIndex({
      schemaVersion: 1,
      projects: [{ path: '/x', addedAt: new Date().toISOString() }],
      threads: [],
    });
    vi.mocked(browserService.disposeForThread).mockClear();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('删哪个对话就关哪个对话的；不存在的对话报错且一个都不关', async () => {
    const a = await threadService.create({ projectPath: '/x', title: 'a' });
    await threadService.create({ projectPath: '/x', title: 'b' });

    await expect(threadService.delete({ threadIds: ['nope'] })).rejects.toMatchObject({ code: 'thread.not_found' });
    expect(browserService.disposeForThread).not.toHaveBeenCalled();

    await threadService.delete({ threadIds: [a.id] });
    expect(vi.mocked(browserService.disposeForThread).mock.calls).toEqual([[a.id]]);
    expect(researchRunStore.removeRunsForThread).toHaveBeenCalledWith(a.id);
    expect(disposeWebResearchThread).toHaveBeenCalledWith(a.id);
    expect(vi.mocked(disposeWebResearchThread).mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(researchRunStore.removeRunsForThread).mock.invocationCallOrder.at(-1)!);
  });
});

/**
 * 归档 / 撤销 / 批量删除（spec 2026-09-21-thread-archive-design §3.3）：先整批校验、再整批改、
 * 一次写盘；校验不过就抛，index 一个字节不动。
 *
 * 夹具里四条对话的 lastActiveAt 各不相同 —— 「归档不动 lastActiveAt」要在它们不相等时才有意义。
 */
describe('threadService.archive / unarchive / delete（批量）', () => {
  let dir: string;
  const T = (id: string, lastActiveAt: string) => ({
    id, projectPath: '/x', title: id, createdAt: '2026-09-01T00:00:00.000Z', lastActiveAt,
  });
  const readRaw = () => readFileSync(path.join(dir, 'index.json'), 'utf8');
  const byId = async () => new Map((await threadService.listAll()).map((t) => [t.id, t]));
  /** 会话文件重定向进临时目录：`paths.SESSIONS_DIR` 是模块加载时按真 home 算好的常量，不能碰真的 ~/.kydog。 */
  const sessionFile = (id: string) => path.join(dir, 'sessions', `${id}.jsonl`);

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-thr-arc-'));
    mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'INDEX_FILE', 'get').mockReturnValue(path.join(dir, 'index.json'));
    vi.spyOn(paths, 'sessionFileFor').mockImplementation((_p, id) => sessionFile(id));
    await saveIndex({
      schemaVersion: 1,
      projects: [{ path: '/x', addedAt: '2026-09-01T00:00:00.000Z' }],
      threads: [
        T('a', '2026-09-04T00:00:00.000Z'),
        T('b', '2026-09-03T00:00:00.000Z'),
        T('c', '2026-09-02T00:00:00.000Z'),
        T('d', '2026-09-01T00:00:00.000Z'),
      ],
    });
    vi.mocked(agentService.dispose).mockClear();
    vi.mocked(browserService.disposeForThread).mockClear();
    vi.mocked(agentService.hasActiveRunFor).mockImplementation(() => false);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('三个一起归档：同一个 archivedAt、lastActiveAt 逐字不变；没点名的 d 一个字段都不动；只对这三个停 agent、关标签', async () => {
    const before = await byId();
    const { threads } = await threadService.archive({ threadIds: ['a', 'b', 'c'] });
    expect(threads.map((t) => t.id)).toEqual(['a', 'b', 'c']);

    const after = await byId();
    const stamps = ['a', 'b', 'c'].map((id) => after.get(id)!.archivedAt);
    expect(stamps[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Set(stamps).size).toBe(1);
    for (const id of ['a', 'b', 'c']) expect(after.get(id)!.lastActiveAt).toBe(before.get(id)!.lastActiveAt);
    expect(after.get('d')).toEqual(before.get('d'));
    expect(vi.mocked(agentService.dispose).mock.calls).toEqual([['a'], ['b'], ['c']]);
    expect(vi.mocked(browserService.disposeForThread).mock.calls).toEqual([['a'], ['b'], ['c']]);
  });

  it('其中一个在飞 → thread.busy 整批拒绝、index 逐字不变；同一批换成都空闲 → 成功', async () => {
    vi.mocked(agentService.hasActiveRunFor).mockImplementation((id) => id === 'b');
    const raw0 = readRaw();
    await expect(threadService.archive({ threadIds: ['a', 'b'] })).rejects.toMatchObject({ code: 'thread.busy' });
    expect(readRaw()).toBe(raw0);
    expect(agentService.dispose).not.toHaveBeenCalled();

    vi.mocked(agentService.hasActiveRunFor).mockImplementation(() => false);
    await threadService.archive({ threadIds: ['a', 'b'] });
    expect((await byId()).get('b')!.archivedAt).toBeDefined();
    expect(vi.mocked(agentService.dispose).mock.calls).toEqual([['a'], ['b']]);
  });

  it('有一个 id 不存在 → thread.not_found，archive 与 delete 都一个不改；去掉它再调 → 成功', async () => {
    const raw0 = readRaw();
    await expect(threadService.archive({ threadIds: ['a', 'nope'] })).rejects.toMatchObject({ code: 'thread.not_found' });
    expect(readRaw()).toBe(raw0);
    await expect(threadService.delete({ threadIds: ['a', 'nope'] })).rejects.toMatchObject({ code: 'thread.not_found' });
    expect(readRaw()).toBe(raw0);
    expect(browserService.disposeForThread).not.toHaveBeenCalled();

    await threadService.archive({ threadIds: ['a'] });
    expect((await byId()).get('a')!.archivedAt).toBeDefined();
    expect(vi.mocked(browserService.disposeForThread).mock.calls).toEqual([['a']]);
  });

  it('unarchive 摘掉 archivedAt；对没归档过的 id 原样返回（幂等）', async () => {
    await threadService.archive({ threadIds: ['a'] });
    expect((await byId()).get('a')!.archivedAt).toBeDefined();

    const { threads } = await threadService.unarchive({ threadIds: ['a', 'd'] });
    expect(threads.map((t) => t.id)).toEqual(['a', 'd']);
    const after = await byId();
    expect(after.get('a')).not.toHaveProperty('archivedAt');
    expect(after.get('d')).not.toHaveProperty('archivedAt');
    expect(after.get('a')!.lastActiveAt).toBe('2026-09-04T00:00:00.000Z');
  });

  it('delete 多个：一次摘掉、各自的会话文件删掉；没点名的 c、d 与 d 的文件都留着', async () => {
    for (const id of ['a', 'b', 'd']) writeFileSync(sessionFile(id), '{}\n');
    await threadService.delete({ threadIds: ['a', 'b'] });

    expect([...(await byId()).keys()].sort()).toEqual(['c', 'd']);
    expect(existsSync(sessionFile('a'))).toBe(false);
    expect(existsSync(sessionFile('b'))).toBe(false);
    expect(existsSync(sessionFile('d'))).toBe(true);
    expect(vi.mocked(browserService.disposeForThread).mock.calls).toEqual([['a'], ['b']]);
    // 研究任务目录与它同一处置：只删点名的两条，且每条一次。
    expect(vi.mocked(xResearchTaskStore.removeThread).mock.calls).toEqual([['a'], ['b']]);
  });
});

describe('web research lifecycle through real thread/project teardown', () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-thread-web-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'INDEX_FILE', 'get').mockReturnValue(path.join(dir, 'index.json'));
    vi.spyOn(paths, 'sessionFileFor').mockImplementation((_project, threadId) => path.join(dir, `${threadId}.jsonl`));
    await saveIndex({ schemaVersion: 1, projects: [{ path: '/web', addedAt: 'now' }], threads: [] });
  });
  afterEach(() => { vi.mocked(disposeWebResearchThread).mockReset(); vi.mocked(researchRunStore.removeRunsForThread).mockReset();
    vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

  it.each(['delete', 'close'] as const)('%s drains a real model callback before removing ownership or directories', async action => {
    const { WebResearchTaskService } = await import('../webResearch/taskService');
    const { TaskStore } = await import('../webResearch/taskStore');
    const { DEFAULT_WEB_RESEARCH_TASK_BUDGET } = await import('../../shared/webResearchTask');
    const { randomUUID } = await import('node:crypto');
    const { promises: fs } = await import('node:fs');
    const thread = await threadService.create({ projectPath: '/web' });
    const store = new TaskStore(dir), run = randomUUID(), sourceId = randomUUID();
    const task = { threadId: thread.id, researchRunId: run, createdByRunId: randomUUID(), projectRoot: dir,
      originalQuestion: 'question', createdAt: 'now', updatedAt: 'now', revision: 1, status: 'running' as const,
      angles: [], attempts: [], observationIds: [], discoveryCount: 0, budget: { ...DEFAULT_WEB_RESEARCH_TASK_BUDGET },
      usage: { candidates: 1, fetchesDispatched: 0, receivedBytes: 0, modelCalls: 0 } };
    await store.createTask(task);
    await store.saveSource(task, { sourceId, requestedUrl: 'https://example.org/page', finalUrl: 'https://example.org/page',
      status: 'queued', reason: 'interrupted', pendingReanalysis: true, contentHash: 'existing-body',
      createdAt: 'now', updatedAt: 'now', discoveries: [], passages: [{ sourceId, passageId: 'p', ordinal: 1, text: 'Existing evidence.' }] });
    let started!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const service = new WebResearchTaskService({ store, fetch: async () => { throw new Error('unexpected fetch'); },
      parse: async () => { throw new Error('unexpected parse'); }, resolveModel: async () => ({ providerId: 'fixture', modelId: 'fixture', runtimeRevision: 1 }),
      adapter: { currentRevision: () => 1, complete: async () => ({ text: '', stopReason: 'stop' }) },
      extract: async ({ sourceId }) => { started(); await gate; return { sourceId, status: 'irrelevant', examinedPassageIds: ['p'], claims: [], evidence: [], gaps: [] }; },
      onUpdate: () => {} });
    const work = service.whenIdle(thread.id, run); await entered;
    expect((await store.loadSource(task, sourceId)).status).toBe('extracting');
    vi.mocked(disposeWebResearchThread).mockImplementation(id => service.disposeThread(id));
    vi.mocked(researchRunStore.removeRunsForThread).mockImplementation(async id => {
      expect((await store.loadSource(task, sourceId)).status).toBe('cancelled');
      await fs.rm(path.join(dir, id), { recursive: true, force: true });
    });
    const directory = path.join(dir, thread.id); expect(existsSync(directory)).toBe(true);
    const deleting = action === 'delete' ? threadService.delete({ threadIds: [thread.id] })
      : (await import('../project/projectService')).projectService.close({ projectPath: '/web' });
    await vi.waitFor(() => expect(disposeWebResearchThread).toHaveBeenCalledWith(thread.id));
    expect(existsSync(directory)).toBe(true);
    finish(); await deleting; await work;
    expect((await loadIndex()).threads).toEqual([]);
    if (action === 'delete') expect(existsSync(directory)).toBe(false);
    else expect((await store.loadSource(task, sourceId)).status).toBe('cancelled');
    await expect(service.get(thread.id, run)).rejects.toThrow('disposed');
  });
});
