import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseAboutDoc, hasLevelOneHeading, type AboutDoc } from './aboutDoc';
import { ABOUT_DOCS, ABOUT_LICENSES } from './aboutDocs';

const ABOUT_DIR = path.resolve(__dirname, '..', '..', '..', 'about');

function mdFiles(): string[] {
  return readdirSync(ABOUT_DIR).filter((f) => f.endsWith('.md')).sort();
}

/** 正文文件 = 除 licenses.md 外的所有 .md，两处需要这个集合的地方共用同一份定义。 */
function posts(): string[] {
  return mdFiles().filter((f) => f !== 'licenses.md');
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
});
