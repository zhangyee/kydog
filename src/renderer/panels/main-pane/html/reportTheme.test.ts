import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HOST_THEME_VARS, NOT_FORWARDED_VARS, HOST_SIZE_VARS, buildHostThemeCss } from './reportTheme';

/** 抓出 vellum.css 里声明过的全部自定义属性名。 */
function declaredVars(): Set<string> {
  const css = readFileSync(
    path.resolve(__dirname, '../../../theme/vellum.css'),
    'utf8',
  );
  const out = new Set<string>();
  for (const m of css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)) out.add(m[1]);
  return out;
}

describe('转发清单', () => {
  // 这条测试的目的：将来往主题里加 token 时，逼迫加的人显式决定「转发还是不转发」。
  // 两个清单的并集必须恰好等于 vellum.css 声明的集合，漏掉任何一个都会红。
  it('转发 + 不转发 == vellum.css 声明的全部变量', () => {
    const declared = declaredVars();
    const covered = new Set<string>([...HOST_THEME_VARS, ...NOT_FORWARDED_VARS]);
    expect([...declared].filter((v) => !covered.has(v))).toEqual([]);
    expect([...covered].filter((v) => !declared.has(v))).toEqual([]);
  });

  it('两个清单不重叠', () => {
    const overlap = HOST_THEME_VARS.filter((v) => (NOT_FORWARDED_VARS as readonly string[]).includes(v));
    expect(overlap).toEqual([]);
  });

  it('字号变量不在主题清单里（它们不由 vellum.css 声明）', () => {
    const declared = declaredVars();
    for (const v of HOST_SIZE_VARS) expect(declared.has(v)).toBe(false);
  });
});

describe('buildHostThemeCss', () => {
  it('把读到的值拼成 :root 块', () => {
    const css = buildHostThemeCss((n) => (n === '--ink' ? ' #222 ' : 'X'));
    expect(css.startsWith(':root {')).toBe(true);
    expect(css).toContain('  --ink: #222;');   // 前后空白被 trim
    expect(css.endsWith('}')).toBe(true);
  });

  it('宿主没定义的变量整条跳过，不注入空值', () => {
    const css = buildHostThemeCss((n) => (n === '--ink' ? '#222' : ''));
    expect(css).toContain('--ink: #222;');
    expect(css).not.toContain('--paper:');
  });

  it('覆盖主题变量与字号变量两组', () => {
    const css = buildHostThemeCss(() => 'V');
    for (const v of [...HOST_THEME_VARS, ...HOST_SIZE_VARS]) expect(css).toContain(`${v}: V;`);
  });
});
