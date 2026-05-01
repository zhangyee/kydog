import { describe, it, expect } from 'vitest';
import { buildSkillsOverride } from './skillResourceLoader';

describe('buildSkillsOverride', () => {
  it('filters disabled names from skills, preserves diagnostics', () => {
    const override = buildSkillsOverride(['fastpaper']);
    const base = {
      skills: [{ name: 'fastpaper' }, { name: 'agent-browser' }],
      diagnostics: [{ kind: 'noop' as const }],
    };
    const out = override(base);
    expect(out.skills.map((s) => s.name)).toEqual(['agent-browser']);
    expect(out.diagnostics).toBe(base.diagnostics);
  });

  it('passes through unchanged when disabled list is empty', () => {
    const override = buildSkillsOverride([]);
    const base = {
      skills: [{ name: 'a' }, { name: 'b' }],
      diagnostics: [],
    };
    const out = override(base);
    expect(out.skills.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('captures disabled list at builder time (snapshot semantics)', () => {
    const list = ['x'];
    const override = buildSkillsOverride([...list]); // copy
    list.push('y'); // mutate after
    const out = override({ skills: [{ name: 'x' }, { name: 'y' }], diagnostics: [] });
    expect(out.skills.map((s) => s.name)).toEqual(['y']); // 'x' filtered, 'y' survived (not in snapshot)
  });
});
