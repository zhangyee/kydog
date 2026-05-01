import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { SkillEntry } from '../../shared/types';
import { settingsService } from '../settings/settingsService';
import { parseSkillFrontmatter } from './parseSkillFrontmatter';
import { listBuiltinSkills, builtinSkillsRoot } from './builtinSkills';
import { KYDOG_SKILLS_DIR } from './skillResourceLoader';

export interface SkillsServiceDeps {
  skillsDir: string;
  isBuiltin: (name: string) => boolean;
  builtinKydogVersion: () => string;
}

export class SkillsService {
  constructor(private readonly deps: SkillsServiceDeps) {}

  async list(): Promise<SkillEntry[]> {
    if (!existsSync(this.deps.skillsDir)) mkdirSync(this.deps.skillsDir, { recursive: true });
    const entries = readdirSync(this.deps.skillsDir, { withFileTypes: true });
    const disabled = (await settingsService.get()).skills.disabledBuiltins;
    const out: SkillEntry[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const dir = path.join(this.deps.skillsDir, e.name);
      const skillFile = path.join(dir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      const parsed = parseSkillFrontmatter(readFileSync(skillFile, 'utf-8'));
      if (!parsed.ok) continue; // bad SKILL.md is invisible to list (preview surface flags it)
      const origin: 'builtin' | 'user' = this.deps.isBuiltin(e.name) ? 'builtin' : 'user';
      const entry: SkillEntry = {
        name: e.name, // dirname is canonical id (§A.1)
        description: parsed.description,
        origin,
        enabled: origin === 'user' ? true : !disabled.includes(e.name),
        dirPath: dir,
      };
      if (origin === 'builtin') entry.kydogVersion = this.deps.builtinKydogVersion();
      out.push(entry);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

export const skillsService = new SkillsService({
  skillsDir: KYDOG_SKILLS_DIR,
  isBuiltin: (name) => listBuiltinSkills(builtinSkillsRoot()).includes(name),
  builtinKydogVersion: () => app.getVersion(),
});
