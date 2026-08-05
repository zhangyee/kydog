import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { settingsService } from '../settings/settingsService';
import * as paths from '../persist/paths';
import { logger } from '../log';
import { createAskBatchExtension } from '../agent/askBatchExtension';

export const KYDOG_SKILLS_DIR = path.join(os.homedir(), '.kydog', 'skills');

export const HARNESS_MAX_CHARS = 24_000;
const HARNESS_ORDER = ['SOUL.md', 'USER.md', 'AGENTS.md'] as const; // spec §9.2

export type AgentsFileEntry = { path: string; content: string };

/**
 * Read SOUL/USER/AGENTS from `dir` (default `paths.ROOT`) in that fixed order,
 * skipping any that are missing. Oversized files are truncated to
 * `HARNESS_MAX_CHARS` with a `[已截断]` marker appended (spec §9.2).
 */
export async function loadHarnessAgentsFiles(dir: string = paths.ROOT): Promise<AgentsFileEntry[]> {
  const out: AgentsFileEntry[] = [];
  for (const name of HARNESS_ORDER) {
    const p = path.join(dir, name);
    let content: string;
    try { content = await fsp.readFile(p, 'utf8'); }
    catch { logger.warn('harness.inject', 'file missing, skipped', { file: name }); continue; }
    if (content.length > HARNESS_MAX_CHARS) {
      logger.warn('harness.inject', 'truncated', { file: name, chars: content.length });
      content = content.slice(0, HARNESS_MAX_CHARS) + '\n[已截断]';
    }
    out.push({ path: p, content });
  }
  return out;
}

/**
 * Build an `agentsFilesOverride` callback that prepends the harness files
 * (SOUL/USER/AGENTS from `~/.kydog/`) ahead of whatever project-level
 * agents files the loader already discovered.
 */
export function buildAgentsFilesOverride(harness: AgentsFileEntry[]) {
  return <F extends AgentsFileEntry>(current: { agentsFiles: F[] }): { agentsFiles: AgentsFileEntry[] } =>
    ({ agentsFiles: [...harness, ...current.agentsFiles] });
}

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
  const harness = await loadHarnessAgentsFiles();
  // 批次独占：loader 与 session 同生命周期，所以守卫天然按 thread 隔离。
  const { factory: askBatchFactory } = createAskBatchExtension();
  return new pi.DefaultResourceLoader({
    cwd: projectCwd,
    agentDir: pi.getAgentDir(),
    noSkills: true,
    additionalSkillPaths: [KYDOG_SKILLS_DIR],
    skillsOverride: buildSkillsOverride(disabled),
    agentsFilesOverride: buildAgentsFilesOverride(harness),
    extensionFactories: [askBatchFactory],
  });
}
