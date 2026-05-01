import path from 'node:path';
import os from 'node:os';
import { settingsService } from '../settings/settingsService';

export const KYDOG_SKILLS_DIR = path.join(os.homedir(), '.kydog', 'skills');

export async function createKydogResourceLoader(projectCwd: string) {
  const pi = await import('@mariozechner/pi-coding-agent');
  // Snapshot disabled list at construction time (spec §A.2): in-flight sessions
  // keep their original filter; new sessions pick up the latest setting.
  const disabled = (await settingsService.get()).skills.disabledBuiltins;
  return new pi.DefaultResourceLoader({
    cwd: projectCwd,
    agentDir: pi.getAgentDir(),
    noSkills: true,
    additionalSkillPaths: [KYDOG_SKILLS_DIR],
    skillsOverride: (base) => ({
      ...base,
      skills: base.skills.filter((s) => !disabled.includes(s.name)),
    }),
  });
}
