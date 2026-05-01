import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { saveIndex } from '../persist/indexFile';
import { threadService } from './threadService';

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
