import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  HOST_THEME_VARS, NOT_FORWARDED_VARS, HOST_SIZE_VARS, buildHostThemeCss,
  resolveInlineTarget, dirnameOf, bytesToBase64,
} from './reportTheme';

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

// 本地图片内联（Task 7b）：DOM 遍历部分（collectLocalImageSrcs / inlineLocalImages）依赖
// DOMParser，vitest 是 node 环境没有 DOMParser/jsdom，不参与单测、由 e2e/46-html-tab.spec.ts
// 覆盖。这里只测能在纯 node 里跑的字符串 / 字节逻辑：路径解析 + 白名单 + base64。
describe('resolveInlineTarget', () => {
  const base = '/proj';
  it('相对路径解析到 base 下', () => {
    expect(resolveInlineTarget(base, 'figs/a.png')).toBe('/proj/figs/a.png');
  });
  it('逃出 base 的一律拒绝', () => {
    expect(resolveInlineTarget(base, '../secrets.png')).toBe(null);
    expect(resolveInlineTarget(base, 'a/../../x.png')).toBe(null);
    expect(resolveInlineTarget(base, '/etc/passwd.png')).toBe(null);
  });
  it('不认的扩展名拒绝', () => {
    expect(resolveInlineTarget(base, 'a.svg.txt')).toBe(null);
    expect(resolveInlineTarget(base, 'a.exe')).toBe(null);
  });
  it('认 png/jpg/jpeg/gif/webp，大小写不敏感', () => {
    for (const f of ['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp']) {
      expect(resolveInlineTarget(base, f)).not.toBe(null);
    }
  });
  it('反斜杠视为逃逸手段一律拒绝（渲染进程没有 node:path 去规范化它）', () => {
    expect(resolveInlineTarget(base, 'a\\..\\..\\x.png')).toBe(null);
  });
  it('windows 盘符绝对路径拒绝', () => {
    expect(resolveInlineTarget(base, 'C:\\x.png')).toBe(null);
  });
});

describe('dirnameOf', () => {
  it('unix 路径取目录部分', () => {
    expect(dirnameOf('/a/b/report.html')).toBe('/a/b');
  });
  it('windows 路径也支持（tab.path 在 windows 上可能是反斜杠）', () => {
    expect(dirnameOf('C:\\a\\b\\report.html')).toBe('C:\\a\\b');
  });
  it('没有目录部分时返回空串', () => {
    expect(dirnameOf('report.html')).toBe('');
  });
});

describe('bytesToBase64', () => {
  it('编码结果与 btoa 对纯文本字符串的结果一致', () => {
    const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    expect(bytesToBase64(bytes)).toBe(btoa('Hello'));
  });
  it('空数组编码为空串', () => {
    expect(bytesToBase64(new Uint8Array())).toBe('');
  });
  it('跨分块边界（> 0x8000 字节）依然编码正确', () => {
    const bytes = new Uint8Array(0x8000 + 10).fill(65); // 全 'A'
    const decoded = atob(bytesToBase64(bytes));
    expect(decoded.length).toBe(bytes.length);
    expect(decoded[0]).toBe('A');
    expect(decoded[decoded.length - 1]).toBe('A');
  });
});
