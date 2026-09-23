import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KydogModelsStore } from './kydogModelsStore';

const STAMP = '0.0.0-test';
/** pi 内置静态目录的生成时间之后的任意时刻；`lastModified` 必须是正数才算数。 */
const FRESH = Date.UTC(2026, 8, 23);

function entry(ids: string[], extra: Record<string, unknown> = {}) {
  return {
    models: ids.map((id) => ({ id, name: id.toUpperCase(), provider: 'p', input: ['text'] })),
    lastModified: FRESH,
    checkedAt: FRESH,
    ...extra,
  } as never;
}

describe('KydogModelsStore', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'kydog-store-'));
    file = path.join(dir, 'models-store.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('write → read 往返，并且落盘的条目盖了写入者版本', async () => {
    const store = new KydogModelsStore(file, STAMP);
    await store.write('deepseek', entry(['a', 'b']));
    expect((await store.read('deepseek'))?.models.map((m) => m.id)).toEqual(['a', 'b']);
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, Record<string, unknown>>;
    expect(onDisk['deepseek']?.['kydogStampedWith']).toBe(STAMP);
  });

  it('两个 provider 各写各的，后写的不会把先写的冲掉', async () => {
    const store = new KydogModelsStore(file, STAMP);
    await store.write('a', entry(['m1']));
    await store.write('b', entry(['m2']));
    expect((await store.read('a'))?.models.map((m) => m.id)).toEqual(['m1']);
    expect((await store.read('b'))?.models.map((m) => m.id)).toEqual(['m2']);
    await store.delete('a');
    expect(await store.read('a')).toBeUndefined();
    expect(await store.read('b')).toBeDefined();
  });

  it('文件不在、或者内容坏了：当成没有缓存，不抛', async () => {
    expect(await new KydogModelsStore(path.join(dir, 'nope.json'), STAMP).read('x')).toBeUndefined();
    writeFileSync(file, '{ 这不是 json');
    expect(await new KydogModelsStore(file, STAMP).read('x')).toBeUndefined();
  });

  it('liveModelIds：本版本写下的、带正数 lastModified 的条目才算数', async () => {
    // 正向：同一份条目，stamp 对得上时给出 id 集合。
    await new KydogModelsStore(file, STAMP).write('deepseek', entry(['live-1', 'live-2']));
    expect([...(await new KydogModelsStore(file, STAMP).liveModelIds('deepseek'))!].sort())
      .toEqual(['live-1', 'live-2']);
    // 只把读的人换成另一个版本（文件一个字没动）→ 不认这份缓存。
    expect(await new KydogModelsStore(file, '9.9.9').liveModelIds('deepseek')).toBeUndefined();
  });

  it('liveModelIds：没有条目 / models 空 / lastModified 不是正数，都是 undefined', async () => {
    const store = new KydogModelsStore(file, STAMP);
    expect(await store.liveModelIds('deepseek')).toBeUndefined();          // 从没拉到过
    await store.write('deepseek', entry([]));
    expect(await store.liveModelIds('deepseek')).toBeUndefined();          // 拉到过，但清单是空的
    // pi 在 404/501 上写回 lastModified: 0 表示「这个 provider 没有远端目录」。
    await store.write('deepseek', entry(['x'], { lastModified: 0 }));
    expect(await store.liveModelIds('deepseek')).toBeUndefined();
    // 正向对照：同样这份 models，lastModified 是正数就算数 —— 上面三条不是因为 'x' 本身不行。
    await store.write('deepseek', entry(['x']));
    expect([...(await store.liveModelIds('deepseek'))!]).toEqual(['x']);
  });
});
