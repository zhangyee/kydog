import { existsSync, readFileSync, readdirSync, mkdirSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { app, shell } from 'electron';
import type { SkillEntry } from '../../shared/types';
import { KydogError } from '../../shared/errors';
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
      if (!parsed.ok) {
        console.warn(`[skills] skipping ${e.name}: ${parsed.reason}`);
        continue;
      }
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

  async setEnabled(name: string, enabled: boolean): Promise<SkillEntry[]> {
    if (!this.deps.isBuiltin(name)) {
      throw new KydogError('skill.invalid', '第三方 skill 不支持禁用，请使用卸载');
    }
    const current = (await settingsService.get()).skills.disabledBuiltins;
    const next = enabled
      ? current.filter((n) => n !== name)
      : Array.from(new Set([...current, name]));
    await settingsService.update({ skills: { disabledBuiltins: next } });
    return this.list();
  }

  async uninstall(name: string): Promise<SkillEntry[]> {
    if (this.deps.isBuiltin(name)) {
      throw new KydogError('skill.uninstall_forbidden', '内置 skill 不支持卸载');
    }
    const dir = path.join(this.deps.skillsDir, name);
    await fsp.rm(dir, { recursive: true, force: true });
    return this.list();
  }

  async openInOS(name: string): Promise<void> {
    const dir = path.join(this.deps.skillsDir, name);
    if (!existsSync(dir)) throw new KydogError('skill.invalid', `未找到 skill ${name}`);
    await shell.openPath(dir);
  }
}

export const skillsService = new SkillsService({
  skillsDir: KYDOG_SKILLS_DIR,
  isBuiltin: (name) => listBuiltinSkills(builtinSkillsRoot()).includes(name),
  builtinKydogVersion: () => app.getVersion(),
});
