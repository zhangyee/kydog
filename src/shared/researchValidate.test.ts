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
