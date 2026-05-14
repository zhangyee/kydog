import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
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

vi.mock('../agent/AgentService', () => ({
  agentService: {
    send: vi.fn().mockResolvedValue({ runId: 'r1' }),
    loadHistory: vi.fn().mockResolvedValue([]),
    dispose: vi.fn(),
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
