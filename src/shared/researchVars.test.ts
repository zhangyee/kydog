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

  it('包含需求点名的 6 个变量，邮箱两项 kind 为 email', () => {
    expect([...PRESET_RESEARCH_VAR_NAMES]).toEqual([
      'NCBI_API_KEY',
      'SEMANTIC_SCHOLAR_API_KEY',
      'OPENALEX_API_KEY',
      'CORE_API_KEY',
      'UNPAYWALL_EMAIL',
      'FASTPAPER_EMAIL',
    ]);
    const kindOf = (n: string) => PRESET_RESEARCH_VARS.find((v) => v.name === n)?.kind;
    expect(kindOf('UNPAYWALL_EMAIL')).toBe('email');
    expect(kindOf('FASTPAPER_EMAIL')).toBe('email');
    expect(kindOf('NCBI_API_KEY')).toBe('key');
  });
});
