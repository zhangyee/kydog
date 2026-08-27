import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readManifest, writeManifest, type SkillManifest } from './manifest';

function file(content?: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'man-'));
  const f = path.join(dir, 'm.json');
  if (content !== undefined) writeFileSync(f, content);
  return f;
}

describe('readManifest', () => {
  it('文件不存在 → ok + 空列表', async () => {
    expect(await readManifest(file())).toEqual({ kind: 'ok', builtin: [] });
  });

  it('新格式 → 原样读出名字列表', async () => {
    const f = file(JSON.stringify({
      schemaVersion: 2, kydogVersion: '0.3.0', writtenAt: 'x', builtin: ['a', 'b'],
    }));
    expect(await readManifest(f)).toEqual({ kind: 'ok', builtin: ['a', 'b'] });
  });

  it('旧格式（带 files 账本）→ 迁移出名字列表，不是 unknown', async () => {
    const f = file(JSON.stringify({
      kydogVersion: '0.2.0', writtenAt: 'x',
      builtin: {
        fastpaper: { kydogVersion: '0.2.0', files: { 'SKILL.md': 'abc' } },
        'paper-summary': { kydogVersion: '0.2.0', files: {} },
      },
    }));
    expect(await readManifest(f)).toEqual({ kind: 'ok', builtin: ['fastpaper', 'paper-summary'] });
  });

  it('JSON 非法 → unknown，不抛', async () => {
    expect(await readManifest(file('{not json'))).toEqual({ kind: 'unknown' });
  });

  it('结构无法识别 → unknown，不抛', async () => {
    expect(await readManifest(file('[1,2,3]'))).toEqual({ kind: 'unknown' });
    expect(await readManifest(file('{"builtin": 42}'))).toEqual({ kind: 'unknown' });
    expect(await readManifest(file('null'))).toEqual({ kind: 'unknown' });
  });
});

describe('writeManifest', () => {
  it('round-trips', async () => {
    const f = file();
    const m: SkillManifest = {
      schemaVersion: 2, kydogVersion: '0.3.0', writtenAt: '2026-08-27T00:00:00Z', builtin: ['fastpaper'],
    };
    await writeManifest(f, m);
    expect(await readManifest(f)).toEqual({ kind: 'ok', builtin: ['fastpaper'] });
  });
});
