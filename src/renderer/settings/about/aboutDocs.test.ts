import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseAboutDoc, hasLevelOneHeading, type AboutDoc } from './aboutDoc';
import { ABOUT_DOCS, ABOUT_LICENSES, ABOUT_PRIVACY } from './aboutDocs';

const ABOUT_DIR = path.resolve(__dirname, '..', '..', '..', 'about');
// __dirname 是 src/renderer/settings/about/，向上四层是仓库根，node_modules 挂在那儿。
const ROOT_DIR = path.resolve(__dirname, '..', '..', '..', '..');

/**
 * licenses.md「## 开源库」小节里，每一行的格式约定为：
 *   - `<package>`: <license-identifier>
 * 包名用反引号包住（scope 包名里的 `@`、`/` 都是合法字符，反引号只是让它在 md 里按 inline code
 * 渲染，不影响解析），冒号后是这行唯一剩下的内容、就是 license 标识符本身。
 * 这个形状手写起来自然，正则也不用理解 markdown 语法，逐行匹配即可。
 */
const LIB_LINE_RE = /^- `([^`]+)`: (.+)$/;

type LibEntry = { pkg: string; license: string };

function parseLicensesLibrarySection(raw: string): LibEntry[] {
  const m = raw.match(/^## 开源库\s*\n([\s\S]*)$/m);
  if (!m) throw new Error('licenses.md 缺少 "## 开源库" 小节');
  return m[1]
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => {
      const lm = line.match(LIB_LINE_RE);
      if (!lm) throw new Error(`licenses.md 开源库小节里有一行不符合 "- \`pkg\`: license" 格式：${line}`);
      return { pkg: lm[1], license: lm[2] };
    });
}

function mdFiles(): string[] {
  return readdirSync(ABOUT_DIR).filter((f) => f.endsWith('.md')).sort();
}

/**
 * 保留名文档：不是正文，不带 frontmatter，由 aboutDocs.ts 单独取出，不参与 date 排序。
 * 与 aboutDocs.ts 里的 LICENSES_SLUG / PRIVACY_SLUG 一一对应，新增一个保留名要两边同时加。
 */
const RESERVED_FILES = new Set(['licenses.md', 'privacy.md']);

/** 正文文件 = 除保留名外的所有 .md，两处需要这个集合的地方共用同一份定义。 */
function posts(): string[] {
  return mdFiles().filter((f) => !RESERVED_FILES.has(f));
}

/**
 * 独立于 aboutDocs.ts 重新读盘 + 解析正文，供下面几个测试拿磁盘上的事实去核对 ABOUT_DOCS，
 * 而不是拿 ABOUT_DOCS 的输出去核对它自己（那样任何一篇内容改了、加了、删了，断言都会跟着自证通过）。
 */
function parsedPosts(): AboutDoc[] {
  return posts().map((f) => {
    const slug = f.replace(/\.md$/, '');
    const r = parseAboutDoc(slug, readFileSync(path.join(ABOUT_DIR, f), 'utf8'));
    if (!r.ok) throw new Error(r.reason);
    return r.doc;
  });
}

describe('src/about 文件契约', () => {
  it('licenses.md 存在且含 OFL 全文', () => {
    const raw = readFileSync(path.join(ABOUT_DIR, 'licenses.md'), 'utf8');
    expect(raw).toContain('SIL OPEN FONT LICENSE');
    // 按协议层事实断言，而不是字符数阈值：OFL 1.1 的五个必备条款小节都得在。
    // 少了任何一节（尤其是 TERMINATION / DISCLAIMER 这两条免责条款）就不是完整的 OFL 全文。
    for (const heading of ['PREAMBLE', 'DEFINITIONS', 'PERMISSION & CONDITIONS', 'TERMINATION', 'DISCLAIMER']) {
      expect(raw, `licenses.md 缺少 OFL 条款小节：${heading}`).toContain(heading);
    }
  });

  it('至少有一篇正文', () => {
    expect(posts().length).toBeGreaterThanOrEqual(1);
  });

  it('每篇正文的 frontmatter 都合法，且 body 非空', () => {
    for (const f of posts()) {
      const slug = f.replace(/\.md$/, '');
      const r = parseAboutDoc(slug, readFileSync(path.join(ABOUT_DIR, f), 'utf8'));
      expect(r.ok, r.ok ? '' : r.reason).toBe(true);
      if (r.ok) {
        expect(r.doc.body.trim().length, `${f}: body 为空或全是空白`).toBeGreaterThan(0);
      }
    }
  });

  it('slug 不重复', () => {
    const slugs = mdFiles().map((f) => f.replace(/\.md$/, ''));
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('date 不重复（同 date 无信号地按 slug 排序，加篇文章不该悄悄改变已有篇目的顺序）', () => {
    const byDate = new Map<string, string[]>();
    for (const doc of parsedPosts()) {
      byDate.set(doc.date, [...(byDate.get(doc.date) ?? []), doc.slug]);
    }
    const collisions = [...byDate.entries()].filter(([, slugs]) => slugs.length > 1);
    const msg = collisions.map(([date, slugs]) => `${date}: ${slugs.join(' vs ')}`).join('; ');
    expect(collisions, `以下 date 撞车：${msg}`).toEqual([]);
  });

  it('没有文件含一级标题（ATX 或 setext；页面自己渲染 <h1>，正文/licenses 里再来一个会撞层级）', () => {
    // OFL 原文里成段的 "---" 是分隔线/setext h2 下划线，不在本条检查范围内，不应误报（见 hasLevelOneHeading 的单测）。
    for (const f of mdFiles()) {
      const raw = readFileSync(path.join(ABOUT_DIR, f), 'utf8');
      expect(hasLevelOneHeading(raw), `${f}: 含有一级标题（ATX "# " 或 setext "=" 下划线），会和页面自身的 <h1> 冲突`).toBe(false);
    }
  });

  it('licenses.md 不含 frontmatter 围栏（它不是一篇正文，不该被套上 title/date）', () => {
    // 一旦有人照着「新增正文」的惯例给 licenses.md 加了 frontmatter，aboutDocs.ts 会把它整段原样
    // 当正文渲染（包括那两行 frontmatter），CommonMark 把它们解成一个 setext 标题，在授权框顶部长出
    // 一坨乱码。这条断言就是不让这种情况混进来。
    const raw = readFileSync(path.join(ABOUT_DIR, 'licenses.md'), 'utf8');
    expect(raw.replace(/^\uFEFF/, '').startsWith('---')).toBe(false);
  });

  it('privacy.md \u4E0D\u542B frontmatter \u56F4\u680F\uFF08\u5E26\u4E86\u5C31\u4F1A\u53C2\u4E0E date \u6392\u5E8F\uFF0C\u628A\u5F53\u524D\u5173\u4E8E\u9875\u6324\u6210\u5F80\u671F\uFF09', () => {
    // \u8FD9\u662F privacy.md \u6700\u5BB9\u6613\u51FA\u7684\u9519\uFF1A\u7167\u7740\u300C\u65B0\u589E\u4E00\u7BC7\u6B63\u6587\u300D\u7684\u60EF\u4F8B\u7ED9\u5B83\u52A0 title/date\u3002
    // \u540E\u679C\u6BD4 licenses.md \u90A3\u6761\u66F4\u91CD \u2014\u2014 \u4E00\u65E6\u5B83\u6709\u4E86\u5408\u6CD5 frontmatter \u53C8\u6070\u597D\u88AB\u5F53\u6B63\u6587\u89E3\u6790\uFF0C
    // \u5B83\u7684 date \u4F1A\u8DDF\u771F\u6B63\u7684\u5173\u4E8E\u9875\u4E89 ABOUT_DOCS[0]\u3002
    const raw = readFileSync(path.join(ABOUT_DIR, 'privacy.md'), 'utf8');
    expect(raw.replace(/^\uFEFF/, '').startsWith('---')).toBe(false);
  });
});

describe('licenses.md\u300C\u5F00\u6E90\u5E93\u300D\u5C0F\u8282\uFF1A\u58F0\u660E\u7684 license \u5FC5\u987B\u8DDF node_modules \u91CC\u7684\u5B9E\u9645\u4E00\u81F4', () => {
  // \u8FD9\u6761\u53EA\u6838\u5BF9\u300C\u5DF2\u7ECF\u5199\u8FDB\u53BB\u7684\u6761\u76EE\u300D\u662F\u5426\u5C5E\u5B9E\uFF0C\u4E0D\u65AD\u8A00\u5217\u8868\u8986\u76D6\u4E86 package.json \u7684\u5168\u90E8\u4F9D\u8D56\u2014\u2014
  // \u5C11\u5217\u4E00\u4E2A\u5305\u4E0D\u662F\u300C\u5047\u300D\uFF0C\u53EA\u662F\u4E0D\u5168\uFF1B\u4F46\u5217\u51FA\u7684\u6BCF\u4E00\u6761\uFF0C\u6807\u8BC6\u7B26\u5FC5\u987B\u8DDF\u5305\u81EA\u5DF1\u58F0\u660E\u7684\u4E00\u5B57\u4E0D\u5DEE\uFF0C
  // \u56E0\u4E3A\u8FD9\u662F\u7ED9\u7528\u6237\u770B\u7684\u6CD5\u5F8B\u5C42\u9762\u7684\u6388\u6743\u58F0\u660E\uFF0C\u4E0D\u8BE5\u51ED\u8BB0\u5FC6\u5199\u3001\u66F4\u4E0D\u8BE5\u6084\u6084\u8DDF\u4F9D\u8D56\u5B9E\u9645\u7684\u8BB8\u53EF\u8BC1\u8131\u8282\u3002
  it('\u6BCF\u4E00\u6761\u58F0\u660E\u7684 license \u90FD\u7B49\u4E8E\u5BF9\u5E94 node_modules/<pkg>/package.json \u7684 license \u5B57\u6BB5', () => {
    const raw = readFileSync(path.join(ABOUT_DIR, 'licenses.md'), 'utf8');
    const entries = parseLicensesLibrarySection(raw);
    expect(entries.length).toBeGreaterThan(0);
    for (const { pkg, license } of entries) {
      const pkgJsonPath = path.join(ROOT_DIR, 'node_modules', pkg, 'package.json');
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { license?: unknown };
      expect(
        pkgJson.license,
        `${pkg}: licenses.md \u58F0\u660E\u7684 license \u662F "${license}"\uFF0C\u4F46 node_modules/${pkg}/package.json \u5B9E\u9645\u662F "${pkgJson.license as string}"`,
      ).toBe(license);
    }
  });
});

describe('ABOUT_DOCS / ABOUT_LICENSES', () => {
  it('ABOUT_DOCS[0] 是 date 最大的一篇', () => {
    expect(ABOUT_DOCS.length).toBeGreaterThanOrEqual(1);
    const maxDate = parsedPosts().reduce((max, d) => (d.date > max ? d.date : max), '');
    expect(ABOUT_DOCS[0].date).toBe(maxDate);
  });

  it('src/about 下每篇正文文件都出现在 ABOUT_DOCS 里，一篇不漏', () => {
    const diskSlugs = parsedPosts().map((d) => d.slug).sort();
    expect(ABOUT_DOCS.map((d) => d.slug).sort()).toEqual(diskSlugs);
  });

  it('按 date 降序', () => {
    const dates = ABOUT_DOCS.map((d) => d.date);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('licenses 不混进 ABOUT_DOCS', () => {
    expect(ABOUT_DOCS.some((d) => d.slug === 'licenses')).toBe(false);
  });

  it('ABOUT_LICENSES 是 licenses.md 原文', () => {
    expect(ABOUT_LICENSES).toBe(readFileSync(path.join(ABOUT_DIR, 'licenses.md'), 'utf8'));
  });

  it('privacy.md 作为保留名被单独取出，不进正文列表', () => {
    expect(ABOUT_PRIVACY.length).toBeGreaterThan(0);
    expect(ABOUT_DOCS.some((d) => d.slug === 'privacy')).toBe(false);
  });

  it('ABOUT_PRIVACY 是 privacy.md 原文', () => {
    expect(ABOUT_PRIVACY).toBe(readFileSync(path.join(ABOUT_DIR, 'privacy.md'), 'utf8'));
  });

  it('隐私说明覆盖 spec 要求的全部披露项', () => {
    // 这几条是对用户的承诺里最实质的部分，少一条就是承诺缩水，不是文案润色：
    //   Cloudflare / 180 天 / Time Travel —— 数据处理方、保留期、以及「删除后仍有
    //     恢复窗口」的诚实交代。窗口正文写作「7 至 30 天」，钉这个短语而不是
    //     '7 天' / '30 天' 两个 token —— 同样锁住两个数字，且不会被拆成两段分别命中别处。
    //   纯随机 —— 标识不从任何设备特征派生（对应 installId.ts「绝不从 MAC/主机名/机器码
    //     派生」的不变量）。这是伪匿名标识与设备指纹的分界，不能悄悄弱化。
    //   默认为勾选 —— onboarding 那个框是预勾选的。这个默认值本身是知情的产品决定
    //     （spec 取舍第 5 条），正因如此更要写出来：省略它看起来像隐瞒。
    //   关于 → 隐私与统计 —— 关闭与删除的真实路径。隐私与统计挂在关于页底部、没有独立
    //     设置页（Task 10），此前写成「设置 → 隐私与统计」是一条走不通的路，比不写更糟。
    for (const must of ['Cloudflare', '180 天', '7 至 30 天', 'Time Travel', '纯随机', '默认为勾选', '关于 → 隐私与统计']) {
      expect(ABOUT_PRIVACY, `隐私说明缺少必须披露的内容：${must}`).toContain(must);
    }
  });
});
