import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseAboutDoc } from './aboutDoc';

const ABOUT_DIR = path.resolve(__dirname, '..', '..', '..', 'about');

function mdFiles(): string[] {
  return readdirSync(ABOUT_DIR).filter((f) => f.endsWith('.md')).sort();
}

describe('src/about 文件契约', () => {
  it('licenses.md 存在且含 OFL 全文', () => {
    const raw = readFileSync(path.join(ABOUT_DIR, 'licenses.md'), 'utf8');
    expect(raw).toContain('SIL OPEN FONT LICENSE');
    expect(raw.length).toBeGreaterThan(3000);
  });

  it('至少有一篇正文', () => {
    const posts = mdFiles().filter((f) => f !== 'licenses.md');
    expect(posts.length).toBeGreaterThanOrEqual(1);
  });

  it('每篇正文的 frontmatter 都合法', () => {
    for (const f of mdFiles()) {
      if (f === 'licenses.md') continue;
      const slug = f.replace(/\.md$/, '');
      const r = parseAboutDoc(slug, readFileSync(path.join(ABOUT_DIR, f), 'utf8'));
      expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    }
  });

  it('slug 不重复', () => {
    const slugs = mdFiles().map((f) => f.replace(/\.md$/, ''));
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
