import path from 'node:path';
import os from 'node:os';
import { settingsService } from '../settings/settingsService';

export const KYDOG_SKILLS_DIR = path.join(os.homedir(), '.kydog', 'skills');

/**
 * Build a `skillsOverride` callback that filters out disabled built-in skills.
 *
 * The returned callback closes over `disabled` — pass the snapshot at construction
 * time. Already-running sessions hold their own callback, so settings changes after
 * loader construction don't affect them (spec §A.2).
 */
export function buildSkillsOverride(
  disabled: readonly string[],
): <S extends { name: string }, D>(base: { skills: S[]; diagnostics: D[] }) => { skills: S[]; diagnostics: D[] } {
  return (base) => ({ ...base, skills: base.skills.filter((s) => !disabled.includes(s.name)) });
}

export async function createKydogResourceLoader(projectCwd: string) {
  const pi = await import('@earendil-works/pi-coding-agent');
  // Snapshot disabled list at construction time (spec §A.2): in-flight sessions
  // keep their original filter; new sessions pick up the latest setting.
  const disabled = (await settingsService.get()).skills.disabledBuiltins;
  return new pi.DefaultResourceLoader({
    cwd: projectCwd,
    agentDir: pi.getAgentDir(),
    noSkills: true,
    additionalSkillPaths: [KYDOG_SKILLS_DIR],
    skillsOverride: buildSkillsOverride(disabled),
  });
}
