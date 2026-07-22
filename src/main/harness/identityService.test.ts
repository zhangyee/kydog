import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getIdentity } from './identityService';

describe('getIdentity', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-id-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('读取 SOUL/USER front matter name（中文、含空格、无 description 均可）', async () => {
    writeFileSync(path.join(dir, 'SOUL.md'), '---\nname: "狗哥"\n---\nbody');
    writeFileSync(path.join(dir, 'USER.md'), '---\nname: "Dr. Zhang"\n---\nbody');
    expect(await getIdentity(dir)).toEqual({ userName: 'Dr. Zhang', agentName: '狗哥' });
  });

  it('文件缺失 → 回退缺省', async () => {
    expect(await getIdentity(dir)).toEqual({ userName: 'You', agentName: 'KyDog' });
  });

  it('front matter 缺 name / 超长 / 非法 → 回退', async () => {
    writeFileSync(path.join(dir, 'SOUL.md'), '---\nrole: x\n---\n');
    writeFileSync(path.join(dir, 'USER.md'), `---\nname: "${'a'.repeat(70)}"\n---\n`);
    expect(await getIdentity(dir)).toEqual({ userName: 'You', agentName: 'KyDog' });
  });

  it('非 front matter 文件 → 回退不抛错', async () => {
    writeFileSync(path.join(dir, 'USER.md'), '# 没有 front matter');
    expect((await getIdentity(dir)).userName).toBe('You');
  });
});
