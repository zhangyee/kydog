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
});
