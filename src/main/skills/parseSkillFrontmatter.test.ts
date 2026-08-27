import { describe, it, expect } from 'vitest';
import { parseSkillFrontmatter } from './parseSkillFrontmatter';

describe('parseSkillFrontmatter', () => {
  it('parses valid frontmatter', async () => {
    const r = await parseSkillFrontmatter('---\nname: agent-browser\ndescription: Browse the web\n---\nbody');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe('agent-browser');
      expect(r.description).toBe('Browse the web');
    }
  });

  it('rejects missing name', async () => {
    const r = await parseSkillFrontmatter('---\ndescription: x\n---');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/name/);
  });

  it('rejects bad name regex', async () => {
    const r = await parseSkillFrontmatter('---\nname: Bad_Name\ndescription: x\n---');
    expect(r.ok).toBe(false);
  });

  it('rejects empty description', async () => {
    const r = await parseSkillFrontmatter('---\nname: x\ndescription: ""\n---');
    expect(r.ok).toBe(false);
  });

  it('rejects description over 1024 chars', async () => {
    const r = await parseSkillFrontmatter(`---\nname: x\ndescription: "${'a'.repeat(1025)}"\n---`);
    expect(r.ok).toBe(false);
  });

  // 无引号 plain scalar 里的半角 `: ` 被 YAML 判成嵌套 mapping，parseFrontmatter 是抛不是返回空。
  // 中文文案用全角 `：` 碰不到，英文 description 一写就中 —— 必须降级成 ok:false 而不是让它逃出去。
  it('半角冒号造成的 YAML 语法错误返回 ok:false，不抛', async () => {
    const r = await parseSkillFrontmatter(
      '---\nname: fact-check\ndescription: How it differs from a review: a review answers this.\n---\nbody');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/YAML/);
  });

  it('frontmatter 整体是坏 YAML 也返回 ok:false', async () => {
    const r = await parseSkillFrontmatter('---\nname: x\n  bad: [unclosed\n---\nbody');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/YAML/);
  });
});
