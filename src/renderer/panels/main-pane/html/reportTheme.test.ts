import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  HOST_THEME_VARS, NOT_FORWARDED_VARS, HOST_SIZE_VARS, buildHostThemeCss,
  resolveInlineTarget, dirnameOf, bytesToBase64, REPORT_CSP, REPORT_THEME_ATTR,
} from './reportTheme';
import { THEME_NAMES } from '../../../../shared/types';

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

// 这条串是 spec「实测记录」那张表逐项验过的原样（内联脚本能跑、fetch 被拦、
// 外部 img 被拦……）。它是纯字符串，node 环境完全测得动，而 e2e 只间接覆盖了
// connect-src 那一项 —— 有人把 img-src 放宽成 *、或给 script-src 加 'unsafe-eval'，
// 不锁的话没有任何测试会红。整串等值断言：改任何一项都必须回到这里改，
// 顺带回去重新实测（reportTheme.ts 的注释里写着为什么）。
describe('REPORT_CSP', () => {
  it('就是实测过的那一串，一个字符都没变', () => {
    expect(REPORT_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
      + "img-src data:; font-src data:; connect-src 'none'; form-action 'none'",
    );
  });
});

// 主题身份（data-kydog-theme）。它跟 REPORT_CSP 一样是一条**两端契约**：
// 一端是 injectHostTheme 写在报告根元素上的属性，另一端是 learning-deck 模板里
// 按它取色的那几条 CSS 规则。属性名或取值集合改了而只改一端，不会报错 ——
// 只会让抬头那条深色带在某套主题下悄悄用错前景色（正是「不报错，只是不对劲」）。
// 所以这里跨文件读模板断言，把两端钉在一起。
//
// ⚠️ 这条不是在测「模板长什么样」，别把它扩成模板的快照测试。它只锁两件事：
//    (1) 属性名两边一致；(2) 模板对 midnight 有显式分支、对「没有这个属性」
//    有确定的默认分支（浏览器里单独打开报告时就是这一支）。
describe('主题身份 data-kydog-theme', () => {
  const template = readFileSync(
    path.resolve(__dirname, '../../../../skills/learning-deck/assets/report-template.html'),
    'utf8',
  );

  it('属性名就是模板里消费的那一个', () => {
    expect(REPORT_THEME_ATTR).toBe('data-kydog-theme');
    expect(template).toContain(REPORT_THEME_ATTR);
  });

  it('模板对 midnight 有显式分支（深色带上的前景色要换成墨色）', () => {
    expect(template).toContain(`[${REPORT_THEME_ATTR}="midnight"]`);
  });

  it('模板不给某套主题写分支就必须落在默认分支上，不能漏成没定义', () => {
    // 只有 midnight 需要单独一条（它是唯一纸色比墨色深的一套）；其余四套走默认。
    // 这条断言的用处：将来有人给 sepia 单独写了一条却忘了 lilac，
    // 「写了几条具名分支」这件事就会在这里被看见。
    const named = THEME_NAMES.filter((t) => template.includes(`[${REPORT_THEME_ATTR}="${t}"]`));
    expect(named).toEqual(['midnight']);
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
