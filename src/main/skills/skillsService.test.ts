import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SkillsService } from './skillsService';

vi.mock('../settings/settingsService', () => ({
  settingsService: { get: vi.fn(), update: vi.fn() },
}));
import { settingsService } from '../settings/settingsService';

function mkSkill(root: string, name: string): void {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\nbody`);
}
function tmp() { return mkdtempSync(path.join(tmpdir(), 'svc-')); }

describe('SkillsService.list', () => {
  it('returns builtin and user skills with correct origin/enabled flags', async () => {
    const skillsDir = tmp();
    mkSkill(skillsDir, 'fastpaper');     // assumed builtin
    mkSkill(skillsDir, 'agent-browser'); // user
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: { disabledBuiltins: ['fastpaper'] },
    });
    const svc = new SkillsService({
      skillsDir,
      isBuiltin: (n) => n === 'fastpaper',
      builtinKydogVersion: () => '0.2.0',
    });
    const list = await svc.list();
    const fp = list.find(s => s.name === 'fastpaper');
    const ab = list.find(s => s.name === 'agent-browser');
    expect(fp?.origin).toBe('builtin');
    expect(fp?.enabled).toBe(false);
    expect(fp?.kydogVersion).toBe('0.2.0');
    expect(ab?.origin).toBe('user');
    expect(ab?.enabled).toBe(true);
    expect(ab?.kydogVersion).toBeUndefined();
  });

  it('skips hidden dirs (.cache, .manifest.json wouldn’t be a dir)', async () => {
    const skillsDir = tmp();
    mkdirSync(path.join(skillsDir, '.cache'));
    mkSkill(skillsDir, 'good');
    (settingsService.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      skills: { disabledBuiltins: [] },
    });
    const svc = new SkillsService({ skillsDir, isBuiltin: () => false, builtinKydogVersion: () => '0' });
    const list = await svc.list();
    expect(list.map(s => s.name)).toEqual(['good']);
  });
});
