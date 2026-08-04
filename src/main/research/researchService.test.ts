import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as paths from '../persist/paths';
import { researchService } from './researchService';
import { __resetResearchEnvForTest } from './researchEnv';
import { settingsService } from '../settings/settingsService';

const TOUCHED = ['NCBI_API_KEY', 'UNPAYWALL_EMAIL'];

describe('researchService', () => {
  let dir: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-research-'));
    vi.spyOn(paths, 'ROOT', 'get').mockReturnValue(dir);
    vi.spyOn(paths, 'SETTINGS_FILE', 'get').mockReturnValue(path.join(dir, 'kydog.json'));
    vi.spyOn(paths, 'LOCK_PATH', 'get').mockReturnValue(path.join(dir, '.kydog.json.lock'));
    for (const k of TOUCHED) { saved.set(k, process.env[k]); delete process.env[k]; }
    __resetResearchEnvForTest();
    // settingsService 是模块级单例，cache 会跨用例存活到下一个临时目录。
    // reset() 走 withLock，既把默认值写进新目录，也把 cache 刷成新目录的内容 ——
    // 少了这一步，「校验失败」那条会断言到上一个用例留下的旧 cache。
    await settingsService.reset();
  });

  afterEach(() => {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('save：落盘 + 写 env，返回归一化结果', async () => {
    const out = await researchService.save({
      presets: { NCBI_API_KEY: '  k1  ', UNPAYWALL_EMAIL: 'a@b.com' },
      custom: [],
    });
    expect(out.presets).toEqual({ NCBI_API_KEY: 'k1', UNPAYWALL_EMAIL: 'a@b.com' });
    expect(process.env.NCBI_API_KEY).toBe('k1');
    const onDisk = await settingsService.get();
    expect(onDisk.research.presets.NCBI_API_KEY).toBe('k1');
  });

  it('get：读回落盘的值', async () => {
    await researchService.save({ presets: { NCBI_API_KEY: 'k1' }, custom: [] });
    expect((await researchService.get()).presets).toEqual({ NCBI_API_KEY: 'k1' });
  });

  it('校验失败：抛 settings.invalid，且不写盘不写 env', async () => {
    await expect(
      researchService.save({ presets: { UNPAYWALL_EMAIL: 'not-an-email' }, custom: [] }),
    ).rejects.toMatchObject({ code: 'settings.invalid' });
    expect(process.env.UNPAYWALL_EMAIL).toBeUndefined();
    expect((await settingsService.get()).research.presets).toEqual({});
  });

  // 锁死「先落盘、后写 env」的顺序：落盘失败时 env 必须没被动过。
  // 顺序一旦颠倒，env 会先被写上，然后 update 抛错 —— 用户当前会话生效、
  // 重启就没了，是最难排查的一类不一致。
  it('落盘失败时不写 env', async () => {
    const spy = vi.spyOn(settingsService, 'update').mockRejectedValue(new Error('disk full'));
    await expect(
      researchService.save({ presets: { NCBI_API_KEY: 'k1' }, custom: [] }),
    ).rejects.toThrow('disk full');
    expect(process.env.NCBI_API_KEY).toBeUndefined();
    spy.mockRestore();
  });

  it('清空已存的值：盘上删掉，env 也删掉', async () => {
    await researchService.save({ presets: { NCBI_API_KEY: 'k1' }, custom: [] });
    await researchService.save({ presets: { NCBI_API_KEY: '' }, custom: [] });
    expect((await settingsService.get()).research.presets).toEqual({});
    expect('NCBI_API_KEY' in process.env).toBe(false);
  });
});
