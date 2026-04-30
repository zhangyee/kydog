import path from 'node:path';
import os from 'node:os';

export const KYDOG_SKILLS_DIR = path.join(os.homedir(), '.kydog', 'skills');

export async function createKydogResourceLoader(projectCwd: string) {
  const pi = await import('@mariozechner/pi-coding-agent');
  return new pi.DefaultResourceLoader({
    cwd: projectCwd,
    agentDir: pi.getAgentDir(),
    noSkills: true,
    additionalSkillPaths: [KYDOG_SKILLS_DIR],
  });
}
