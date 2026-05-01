import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createKydogResourceLoader } from './skillResourceLoader';

vi.mock('../settings/settingsService', () => ({
  settingsService: {
    get: vi.fn(),
  },
}));
import { settingsService } from '../settings/settingsService';

type SkillsBase = {
  skills: Array<{ name: string; description: string; filePath: string; baseDir: string; sourceInfo: unknown; disableModelInvocation: boolean }>;
  diagnostics: unknown[];
};

function makeSkill(name: string): SkillsBase['skills'][number] {
  return { name, description: '', filePath: '', baseDir: '', sourceInfo: {} as never, disableModelInvocation: false };
}

describe('createKydogResourceLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes a skillsOverride that filters disabledBuiltins from the base skills', async () => {
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: { disabledBuiltins: ['fastpaper'] },
    });
    const loader = await createKydogResourceLoader('/tmp');
    // pi's DefaultResourceLoader stores the option as a class field of the same name.
    const override = (loader as unknown as { skillsOverride?: (b: SkillsBase) => SkillsBase }).skillsOverride;
    expect(typeof override).toBe('function');

    const base: SkillsBase = {
      skills: [makeSkill('fastpaper'), makeSkill('agent-browser')],
      diagnostics: [],
    };
    const filtered = override!(base);
    expect(filtered.skills.map((s) => s.name)).toEqual(['agent-browser']);
    // diagnostics preserved
    expect(filtered.diagnostics).toBe(base.diagnostics);
  });

  it('with empty disabledBuiltins, override is a no-op pass-through', async () => {
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: { disabledBuiltins: [] },
    });
    const loader = await createKydogResourceLoader('/tmp');
    const override = (loader as unknown as { skillsOverride?: (b: SkillsBase) => SkillsBase }).skillsOverride;
    const base: SkillsBase = {
      skills: [makeSkill('a'), makeSkill('b')],
      diagnostics: [],
    };
    const out = override!(base);
    expect(out.skills.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('captures disabled list at construction time (not re-read on each call)', async () => {
    const getMock = settingsService.get as ReturnType<typeof vi.fn>;
    getMock.mockResolvedValueOnce({ skills: { disabledBuiltins: ['x'] } });
    const loader = await createKydogResourceLoader('/tmp');
    const override = (loader as unknown as { skillsOverride?: (b: SkillsBase) => SkillsBase }).skillsOverride!;
    // Even if settings later "change" (the closure should not re-read), filter still uses 'x'.
    getMock.mockResolvedValue({ skills: { disabledBuiltins: ['y'] } });
    const out = override({ skills: [makeSkill('x'), makeSkill('y')], diagnostics: [] });
    expect(out.skills.map((s) => s.name)).toEqual(['y']);
  });
});
