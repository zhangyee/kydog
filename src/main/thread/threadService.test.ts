import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { saveIndex } from '../persist/indexFile';
import { threadService } from './threadService';
import { agentService } from '../agent/AgentService';

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
    ).rejects.toThrow(/thread\.has_messages/);
  });

  it('rejects switch when target project not opened', async () => {
    vi.spyOn(agentService, 'loadHistory').mockResolvedValue([]);
    const t = await threadService.create({ projectPath: '/a' });
    await expect(
      threadService.update({ threadId: t.id, projectPath: '/does-not-exist' }),
    ).rejects.toThrow(/project\.not_found/);
  });
});
