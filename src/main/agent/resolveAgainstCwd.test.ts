import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveAgainstCwd } from './resolveAgainstCwd';

describe('resolveAgainstCwd', () => {
  it('相对路径拼到 cwd 后面，且不 normalize —— .. 段原样留着', () => {
    // 正向：真的拼上了 cwd。
    expect(resolveAgainstCwd('papers/a.docx', '/proj')).toBe(`/proj${path.sep}papers/a.docx`);
    // 不 normalize 的证据：path.join / path.resolve 会把这一路吃成 '/etc/x.docx'，
    // 这里必须仍然含着 '..' 段，留给下游的校验器去挡。
    const resolved = resolveAgainstCwd('papers/../../etc/x.docx', '/proj') as string;
    expect(resolved).toContain('..');
    expect(resolved).toBe(`/proj${path.sep}papers/../../etc/x.docx`);
    expect(resolved).not.toBe(path.join('/proj', 'papers/../../etc/x.docx'));
  });

  it('绝对路径原样返回，不管给没给 cwd', () => {
    expect(resolveAgainstCwd('/a/b.docx', '/proj')).toBe('/a/b.docx');
    expect(resolveAgainstCwd('/a/b.docx', undefined)).toBe('/a/b.docx');
  });

  it('没给 cwd 时相对路径原样返回（交给下游校验器按老规矩拒绝）', () => {
    expect(resolveAgainstCwd('papers/a.docx', undefined)).toBe('papers/a.docx');
  });

  it('非字符串 / 空串原样返回，不代它判断类型', () => {
    expect(resolveAgainstCwd(undefined, '/proj')).toBeUndefined();
    expect(resolveAgainstCwd(123, '/proj')).toBe(123);
    expect(resolveAgainstCwd('', '/proj')).toBe('');
  });
});
