import { describe, it, expect } from 'vitest';
import { parseAboutDoc, sortAboutDocs, type AboutDoc } from './aboutDoc';

const OK = `---
title: 关于 KyDog
date: 2026-08-03
---

正文第一段。

正文第二段。
`;

describe('parseAboutDoc', () => {
  it('解析出 title / date / body，body 不含 frontmatter', () => {
    const r = parseAboutDoc('2026-08-03-hello', OK);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc).toEqual({
      slug: '2026-08-03-hello',
      title: '关于 KyDog',
      date: '2026-08-03',
      body: '正文第一段。\n\n正文第二段。\n',
    });
  });

  it('缺 title → 失败', () => {
    const r = parseAboutDoc('a', '---\ndate: 2026-08-03\n---\n正文\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('title');
  });

  it('缺 date → 失败', () => {
    const r = parseAboutDoc('a', '---\ntitle: T\n---\n正文\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('date');
  });

  it.each(['2026-8-3', '2026/08/03', 'yesterday'])('date 格式非法 %s → 失败', (bad) => {
    const r = parseAboutDoc('a', `---\ntitle: T\ndate: ${bad}\n---\n正文\n`);
    expect(r.ok).toBe(false);
  });

  it('date 格式对但不是真实日期（2026-13-01）→ 失败', () => {
    const r = parseAboutDoc('a', '---\ntitle: T\ndate: 2026-13-01\n---\n正文\n');
    expect(r.ok).toBe(false);
  });

  it('完全没有 frontmatter → 失败', () => {
    const r = parseAboutDoc('a', '# 标题\n\n正文\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('frontmatter');
  });

  it('frontmatter 未闭合 → 失败', () => {
    const r = parseAboutDoc('a', '---\ntitle: T\ndate: 2026-08-03\n正文\n');
    expect(r.ok).toBe(false);
  });

  it('CRLF 换行也能解析', () => {
    const r = parseAboutDoc('a', '---\r\ntitle: T\r\ndate: 2026-08-03\r\n---\r\n\r\n正文\r\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.title).toBe('T');
    expect(r.doc.body).toBe('正文\n');
  });

  it('body 里的 --- 分隔线不会被当成 frontmatter 结束符', () => {
    const r = parseAboutDoc('a', '---\ntitle: T\ndate: 2026-08-03\n---\n\n一段\n\n---\n\n二段\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.body).toBe('一段\n\n---\n\n二段\n');
  });

  it('值两侧的引号被剥掉', () => {
    const r = parseAboutDoc('a', '---\ntitle: "关于"\ndate: 2026-08-03\n---\n正文\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.title).toBe('关于');
  });
});

describe('sortAboutDocs', () => {
  const mk = (slug: string, date: string): AboutDoc => ({ slug, title: slug, date, body: '' });

  it('按 date 降序', () => {
    const out = sortAboutDocs([mk('a', '2026-05-01'), mk('b', '2026-08-03'), mk('c', '2026-07-01')]);
    expect(out.map((d) => d.slug)).toEqual(['b', 'c', 'a']);
  });

  it('同 date 按 slug 降序 tie-break', () => {
    const out = sortAboutDocs([mk('aaa', '2026-08-03'), mk('zzz', '2026-08-03')]);
    expect(out.map((d) => d.slug)).toEqual(['zzz', 'aaa']);
  });

  it('不改动入参数组', () => {
    const input = [mk('a', '2026-05-01'), mk('b', '2026-08-03')];
    sortAboutDocs(input);
    expect(input.map((d) => d.slug)).toEqual(['a', 'b']);
  });

  it('空数组', () => {
    expect(sortAboutDocs([])).toEqual([]);
  });
});
