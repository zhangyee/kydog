import { describe, it, expect } from 'vitest';
import { parseSkillFrontmatter } from './parseSkillFrontmatter';

describe('parseSkillFrontmatter', () => {
  it('parses valid frontmatter', () => {
    const r = parseSkillFrontmatter('---\nname: agent-browser\ndescription: Browse the web\n---\nbody');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe('agent-browser');
      expect(r.description).toBe('Browse the web');
    }
  });

  it('rejects missing name', () => {
    const r = parseSkillFrontmatter('---\ndescription: x\n---');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/name/);
  });

  it('rejects bad name regex', () => {
    const r = parseSkillFrontmatter('---\nname: Bad_Name\ndescription: x\n---');
    expect(r.ok).toBe(false);
  });

  it('rejects empty description', () => {
    const r = parseSkillFrontmatter('---\nname: x\ndescription: ""\n---');
    expect(r.ok).toBe(false);
  });

  it('rejects description over 1024 chars', () => {
    const r = parseSkillFrontmatter(`---\nname: x\ndescription: "${'a'.repeat(1025)}"\n---`);
    expect(r.ok).toBe(false);
  });
});
