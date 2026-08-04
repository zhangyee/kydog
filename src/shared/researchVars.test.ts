import { describe, it, expect } from 'vitest';
import { PRESET_RESEARCH_VARS, PRESET_RESEARCH_VAR_NAMES } from './researchVars';

describe('researchVars', () => {
  it('6 个预设项，变量名唯一', () => {
    expect(PRESET_RESEARCH_VARS).toHaveLength(6);
    expect(PRESET_RESEARCH_VAR_NAMES.size).toBe(6);
  });

  it('每项都有非空 label / sources / note，kind 合法', () => {
    for (const v of PRESET_RESEARCH_VARS) {
      expect(v.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(v.label.length).toBeGreaterThan(0);
      expect(v.sources.length).toBeGreaterThan(0);
      expect(v.note.length).toBeGreaterThan(0);
      expect(['key', 'email']).toContain(v.kind);
    }
  });

  it('6 个变量的顺序与 kind 都锁死', () => {
    expect(PRESET_RESEARCH_VARS.map((v) => [v.name, v.kind])).toEqual([
      ['NCBI_API_KEY', 'key'],
      ['SEMANTIC_SCHOLAR_API_KEY', 'key'],
      ['OPENALEX_API_KEY', 'key'],
      ['CORE_API_KEY', 'key'],
      ['UNPAYWALL_EMAIL', 'email'],
      ['FASTPAPER_EMAIL', 'email'],
    ]);
  });
});
