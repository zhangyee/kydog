import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { saveIndex } from '../persist/indexFile';
import { threadService } from './threadService';
import { agentService } from '../agent/AgentService';

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
  });
});
