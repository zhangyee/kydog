import { describe, it, expect } from 'vitest';
import type { SettingsFile } from './types';
import {
  RESERVED_ENV_NAMES,
  normalizeResearch,
  validateResearch,
  validateCustomVarName,
} from './researchValidate';
import { PRESET_RESEARCH_VARS } from './researchVars';

const R = (r: Partial<SettingsFile['research']>): SettingsFile['research'] =>
  ({ presets: {}, custom: [], ...r });

describe('normalizeResearch', () => {
  it('trim 值与变量名，剔掉空的预设项', () => {
    const out = normalizeResearch(R({
      presets: { NCBI_API_KEY: '  k1  ', CORE_API_KEY: '   ' },
      custom: [{ name: '  MY_KEY ', kind: 'key', value: ' v1 ' }],
    }));
    expect(out.presets).toEqual({ NCBI_API_KEY: 'k1' });
    expect(out.custom).toEqual([{ name: 'MY_KEY', kind: 'key', value: 'v1' }]);
  });

  it('自定义项值为空时保留条目，值归一化成空串', () => {
    const out = normalizeResearch(R({ custom: [{ name: 'A_KEY', kind: 'key', value: '  ' }] }));
    expect(out.custom).toEqual([{ name: 'A_KEY', kind: 'key', value: '' }]);
  });

  // normalizeResearch 是信任边界上的函数：输入来自磁盘 JSON 和 IPC payload，
  // 两者在运行时都可以是任意形状，类型标注在这里不作数。它必须对任何 unknown
  // 输入都是全函数（total），不该抛，而是把不认得的形状当成「没有」，落回空表。
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
  ])('normalizeResearch 对畸形输入 %s 不抛错，返回空表', (_label, input) => {
    expect(() => normalizeResearch(input as never)).not.toThrow();
    const out = normalizeResearch(input as never);
    expect(out.presets).toEqual({});
    expect(out.custom).toEqual([]);
  });

  // custom 元素本身是对象（过了容器/元素级别的过滤），但字段类型不对 ——
  // 这两条不能并进上面那张表：归一化后 custom 不是空数组，而是一个
  // name: '' 的条目（空名会被 validateCustomVarName 判非法，走正常报错
  // 路径，比条目整条静默消失更容易排查）。
  it('normalizeResearch 对畸形输入 custom 元素是空对象 不抛错，收敛出一个全空条目', () => {
    expect(() => normalizeResearch({ presets: {}, custom: [{}] } as never)).not.toThrow();
    const out = normalizeResearch({ presets: {}, custom: [{}] } as never);
    expect(out.custom).toEqual([{ name: '', kind: 'key', value: '' }]);
  });

  it('normalizeResearch 对畸形输入 custom 元素的 name 是数字 不抛错，name 收敛成空串', () => {
    const input = { presets: {}, custom: [{ name: 42, kind: 'key', value: 'v' }] };
    expect(() => normalizeResearch(input as never)).not.toThrow();
    const out = normalizeResearch(input as never);
    expect(out.custom).toEqual([{ name: '', kind: 'key', value: 'v' }]);
  });

  // 防止形状收敛写过头：合法数据（包括 kind: 'email'）必须原样通过。
  it('合法输入原样通过收敛', () => {
    expect(normalizeResearch({
      presets: { NCBI_API_KEY: 'k1' },
      custom: [{ name: 'MY_KEY', kind: 'email', value: 'a@b.com' }],
    })).toEqual({
      presets: { NCBI_API_KEY: 'k1' },
      custom: [{ name: 'MY_KEY', kind: 'email', value: 'a@b.com' }],
    });
  });
});

describe('validateResearch', () => {
  it('干净输入没有错误', () => {
    expect(validateResearch(R({
      presets: { NCBI_API_KEY: 'k', UNPAYWALL_EMAIL: 'a@b.com' },
      custom: [{ name: 'MY_KEY', kind: 'key', value: 'v' }],
    }))).toEqual([]);
  });

  it('presets 出现未知键 → 报错', () => {
    const errs = validateResearch(R({ presets: { NOT_A_PRESET: 'x' } }));
    expect(errs).toHaveLength(1);
    expect(errs[0].field).toBe('NOT_A_PRESET');
  });

  it.each([
    ['1BAD', '首字符是数字'],
    ['HAS-DASH', '含连字符'],
    ['', '空名'],
    ['has space', '含空格'],
  ])('自定义变量名 %s 非法（%s）', (name) => {
    const errs = validateResearch(R({ custom: [{ name, kind: 'key', value: 'v' }] }));
    expect(errs.length).toBeGreaterThan(0);
  });

  it.each(['PATH', 'AWS_REGION', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS'])(
    '自定义变量名 %s 落在保留名单',
    (name) => {
      const errs = validateResearch(R({ custom: [{ name, kind: 'key', value: 'v' }] }));
      expect(errs).toHaveLength(1);
      expect(errs[0].field).toBe(name);
    },
  );

  it('自定义变量名与预设重名 → 报错', () => {
    const errs = validateResearch(R({ custom: [{ name: 'NCBI_API_KEY', kind: 'key', value: 'v' }] }));
    expect(errs).toHaveLength(1);
  });

  it('两个自定义项重名 → 报错', () => {
    const errs = validateResearch(R({
      custom: [
        { name: 'DUP_KEY', kind: 'key', value: 'a' },
        { name: 'DUP_KEY', kind: 'key', value: 'b' },
      ],
    }));
    expect(errs).toHaveLength(1);
  });

  it.each(['nope', 'a@b', 'a b@c.com', '@b.com'])('邮箱 %s 格式非法', (value) => {
    const errs = validateResearch(R({ presets: { UNPAYWALL_EMAIL: value } }));
    expect(errs).toHaveLength(1);
    expect(errs[0].field).toBe('UNPAYWALL_EMAIL');
  });

  it('自定义 email 项同样走邮箱校验', () => {
    const errs = validateResearch(R({ custom: [{ name: 'X_EMAIL', kind: 'email', value: 'nope' }] }));
    expect(errs).toHaveLength(1);
  });

  it('空值不触发邮箱校验（空 = 未设置）', () => {
    expect(validateResearch(R({ custom: [{ name: 'X_EMAIL', kind: 'email', value: '' }] }))).toEqual([]);
  });

  it.each([['a\nb'], ['a\u0000b'], ['a\u007fb']])('值含控制字符 %j → 报错', (value) => {
    const errs = validateResearch(R({ presets: { NCBI_API_KEY: value } }));
    expect(errs).toHaveLength(1);
  });

  it.each([['a\nb'], ['a\u0000b'], ['a\u007fb']])('自定义项的值含控制字符 %j → 报错', (value) => {
    const errs = validateResearch(R({ custom: [{ name: 'CTRL_KEY', kind: 'key', value }] }));
    expect(errs).toHaveLength(1);
    expect(errs[0].field).toBe('CTRL_KEY');
  });

  it('presets 与 custom 的错误累加', () => {
    const errs = validateResearch(R({
      presets: { UNPAYWALL_EMAIL: 'nope' },
      custom: [{ name: 'PATH', kind: 'key', value: 'v' }],
    }));
    expect(errs.map((e) => e.field).sort()).toEqual(['PATH', 'UNPAYWALL_EMAIL']);
  });

  it('空变量名的 field 保持原始空串，不替换成展示用占位符', () => {
    const errs = validateResearch(R({ custom: [{ name: '', kind: 'key', value: 'v' }] }));
    expect(errs).toHaveLength(1);
    expect(errs[0].field).toBe('');
  });
});

describe('validateCustomVarName', () => {
  it('合法名返回 null', () => {
    expect(validateCustomVarName('MY_KEY', [])).toBeNull();
  });

  it('与已有名冲突返回提示', () => {
    expect(validateCustomVarName('MY_KEY', ['MY_KEY'])).toContain('已存在');
  });

  it('保留名返回提示', () => {
    expect(validateCustomVarName('PATH', [])).toContain('保留');
  });

  it.each(['Path', 'path', 'nOdE_oPtIoNs', 'aws_region', 'anthropic_api_key'])(
    '保留名的大小写变体 %s 同样被拦（Windows 的 process.env 大小写不敏感）',
    (name) => {
      expect(validateCustomVarName(name, [])).toContain('保留');
    },
  );

  it.each(['ncbi_api_key', 'Unpaywall_Email'])(
    '预设名的大小写变体 %s 同样被拦',
    (name) => {
      expect(validateCustomVarName(name, [])).toContain('预设项');
    },
  );
});

describe('RESERVED_ENV_NAMES', () => {
  it('三类保留名各取一个都在集合里', () => {
    expect(RESERVED_ENV_NAMES.has('AWS_REGION')).toBe(true);        // 云 provider（派生自 MANAGED_VARS）
    expect(RESERVED_ENV_NAMES.has('PATH')).toBe(true);              // 进程关键变量（字面量）
    expect(RESERVED_ENV_NAMES.has('ANTHROPIC_API_KEY')).toBe(true); // LLM key（派生自 STATIC_META）
  });

  it('不误伤预设的文献变量', () => {
    for (const v of PRESET_RESEARCH_VARS) expect(RESERVED_ENV_NAMES.has(v.name)).toBe(false);
  });
});
