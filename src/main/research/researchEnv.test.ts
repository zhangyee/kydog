import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SettingsFile } from '../../shared/types';
import { applyResearchEnv, __resetResearchEnvForTest } from './researchEnv';
import { logger } from '../log';

const TOUCHED = ['NCBI_API_KEY', 'UNPAYWALL_EMAIL', 'CORE_API_KEY', 'MY_KEY', 'AMBIENT_KEY', '1BAD'];

const R = (r: Partial<SettingsFile['research']>): SettingsFile['research'] =>
  ({ presets: {}, custom: [], ...r });

describe('researchEnv.applyResearchEnv', () => {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const k of TOUCHED) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
    __resetResearchEnvForTest();
  });
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.restoreAllMocks();
  });

  it('预设与自定义都写进 process.env', () => {
    applyResearchEnv(R({
      presets: { NCBI_API_KEY: 'k1', UNPAYWALL_EMAIL: 'a@b.com' },
      custom: [{ name: 'MY_KEY', kind: 'key', value: 'v1' }],
    }));
    expect(process.env.NCBI_API_KEY).toBe('k1');
    expect(process.env.UNPAYWALL_EMAIL).toBe('a@b.com');
    expect(process.env.MY_KEY).toBe('v1');
  });

  it('空值不写入', () => {
    applyResearchEnv(R({ presets: { NCBI_API_KEY: '' } }));
    expect(process.env.NCBI_API_KEY).toBeUndefined();
  });

  it('原本没有该变量 → 清空后被 delete', () => {
    applyResearchEnv(R({ presets: { NCBI_API_KEY: 'k1' } }));
    applyResearchEnv(R({}));
    expect('NCBI_API_KEY' in process.env).toBe(false);
  });

  it('原本有 ambient 值 → 清空后恢复 ambient，而不是 delete', () => {
    process.env.AMBIENT_KEY = 'from-shell';
    applyResearchEnv(R({ custom: [{ name: 'AMBIENT_KEY', kind: 'key', value: 'from-kydog' }] }));
    expect(process.env.AMBIENT_KEY).toBe('from-kydog');
    applyResearchEnv(R({}));
    expect(process.env.AMBIENT_KEY).toBe('from-shell');
  });

  it('ambient 只记第一次：改过两轮再清空，回到最初的 ambient', () => {
    process.env.AMBIENT_KEY = 'from-shell';
    applyResearchEnv(R({ custom: [{ name: 'AMBIENT_KEY', kind: 'key', value: 'A' }] }));
    applyResearchEnv(R({ custom: [{ name: 'AMBIENT_KEY', kind: 'key', value: 'B' }] }));
    expect(process.env.AMBIENT_KEY).toBe('B');
    applyResearchEnv(R({}));
    expect(process.env.AMBIENT_KEY).toBe('from-shell');
  });

  it('只清掉这一轮不再需要的，其余保持', () => {
    applyResearchEnv(R({ presets: { NCBI_API_KEY: 'k1', CORE_API_KEY: 'k2' } }));
    applyResearchEnv(R({ presets: { NCBI_API_KEY: 'k1' } }));
    expect(process.env.NCBI_API_KEY).toBe('k1');
    expect('CORE_API_KEY' in process.env).toBe(false);
  });

  // 变量名格式非法（数字开头），但 OS 层面完全可写 —— 过滤器一旦失效，
  // 这个值会真的落进 process.env，所以这条测试是可观测的。
  // 空变量名那种情况不在这里测：Node 对 process.env[''] = x 静默丢弃，
  // 无论过滤器是否生效结果都一样，断言不出东西来。它对应的契约
  // （validateResearch 的 field 必须是原始 key）已由 researchValidate.test.ts
  // 里那条红绿验证过的用例锁死。
  it('变量名格式非法的条目被过滤掉，不写进 env', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    applyResearchEnv(R({
      presets: { NCBI_API_KEY: 'k1' },
      custom: [{ name: '1BAD', kind: 'key', value: 'should-not-apply' }],
    }));
    expect(process.env.NCBI_API_KEY).toBe('k1');
    expect(process.env['1BAD']).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('非法条目被跳过并 warn，合法条目照常生效', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    applyResearchEnv(R({
      presets: { NCBI_API_KEY: 'k1' },
      custom: [{ name: 'PATH', kind: 'key', value: 'hijacked' }],
    }));
    expect(process.env.NCBI_API_KEY).toBe('k1');
    expect(process.env.PATH).not.toBe('hijacked');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // 过滤按名字而非按条目：同一个变量名下只要有一个条目非法（这里是自定义项
  // 与预设重名），该名字下所有条目都不写入 —— 哪怕其中一个本来是合法的。
  it('同名冲突时该名字下所有条目都不写入，包括本来合法的那个', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    applyResearchEnv(R({
      presets: { NCBI_API_KEY: 'legit-preset-value' },
      custom: [{ name: 'NCBI_API_KEY', kind: 'key', value: 'dup' }],
    }));
    expect(process.env.NCBI_API_KEY).toBeUndefined();
    warn.mockRestore();
  });

  it('同名冲突会清掉上一轮已生效的合法值', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    applyResearchEnv(R({ presets: { NCBI_API_KEY: 'legit-preset-value' } }));
    expect(process.env.NCBI_API_KEY).toBe('legit-preset-value');
    applyResearchEnv(R({
      presets: { NCBI_API_KEY: 'legit-preset-value' },
      custom: [{ name: 'NCBI_API_KEY', kind: 'key', value: 'dup' }],
    }));
    expect(process.env.NCBI_API_KEY).toBeUndefined();
    warn.mockRestore();
  });

  it('custom 里混入畸形元素不抛错，合法条目照常生效', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(() => applyResearchEnv({
      presets: { NCBI_API_KEY: 'k1' },
      // 模拟手改 kydog.json 或 JSON.stringify 把数组空洞序列化成 null
      custom: [null, { name: 'MY_KEY', kind: 'key', value: 'v1' }] as never,
    })).not.toThrow();
    expect(process.env.NCBI_API_KEY).toBe('k1');
    expect(process.env.MY_KEY).toBe('v1');
    warn.mockRestore();
  });

  // applyResearchEnv 是启动必经路径（main.ts 直接传磁盘原始值），必须和
  // normalizeResearch 一样对任意 unknown 输入都不抛 —— 这里覆盖的是
  // researchValidate.test.ts 里 normalizeResearch 那张表的同一组畸形输入，
  // 两个入口都要保。
  it.each([
    ['custom 元素含 null', { presets: {}, custom: [null] }],
    ['custom 元素全非对象', { presets: {}, custom: ['garbage', 42, undefined] }],
    ['custom 是字符串', { presets: {}, custom: 'nope' }],
    ['custom 是对象（非数组）', { presets: {}, custom: { a: 1 } }],
    ['presets 是字符串', { presets: 'nope', custom: [] }],
    ['presets 是数组', { presets: ['a'], custom: [] }],
    ['presets 的值是嵌套对象', { presets: { NCBI_API_KEY: { nested: 1 } }, custom: [] }],
    ['presets 的值是 null', { presets: { NCBI_API_KEY: null }, custom: [] }],
    ['整个对象是 undefined', undefined],
    ['整个对象是 null', null],
    ['整个对象是字符串', 'garbage'],
    ['custom 元素是空对象', { presets: {}, custom: [{}] }],
    ['custom 元素的 name 是数字', { presets: {}, custom: [{ name: 42, kind: 'key', value: 'v' }] }],
  ])('applyResearchEnv 对畸形输入 %s 不抛错', (_label, input) => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(() => applyResearchEnv(input as never)).not.toThrow();
    warn.mockRestore();
  });
});
