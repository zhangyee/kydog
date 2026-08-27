import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import { settingsService } from '../settings/settingsService';
import * as paths from '../persist/paths';
import { logger } from '../log';
import { createAskBatchExtension } from '../agent/askBatchExtension';
import { buildKydogSystemPrompt } from '../agent/systemPrompt';
import { withSkillTree } from './skillTreeLock';

export const KYDOG_SKILLS_DIR = path.join(os.homedir(), '.kydog', 'skills');

// pi 把我们当成它自己的 CLI，`getAgentDir()` 会返回 ~/.pi/agent —— 也就是用户 pi CLI
// 的家目录。KyDog 只是 SDK 嵌入方，不该读那里的 settings.json / SYSTEM.md / extensions，
// 否则装了 pi 的机器和没装的机器行为不一致，且无从察觉。指向自己的目录把这条路断掉。
// 从 paths.ROOT 派生（而不是 os.homedir()）是为了让测试能重定向到临时目录。
export const kydogAgentDir = (): string => path.join(paths.ROOT, 'agent');

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
  // 整个构建过程要读 ~/.kydog/skills/，不能跟同步/卸载/安装的整树替换交错，故整体包锁。
  return withSkillTree(async () => {
    const pi = await import('@earendil-works/pi-coding-agent');
    // Snapshot disabled list at construction time (spec §A.2): in-flight sessions
    // keep their original filter; new sessions pick up the latest setting.
    const disabled = (await settingsService.get()).skills.disabledBuiltins;
    const harness = await loadHarnessAgentsFiles();
    // 批次独占：loader 与 session 同生命周期，所以守卫天然按 thread 隔离。
    const { factory: askBatchFactory } = createAskBatchExtension();
    // 不给 systemPromptOverride 的话 pi 会拼它自己的默认提示词（「You are an expert coding
    // assistant operating inside pi…」），排在 SOUL/USER/AGENTS 之前，等于两套人格并存。
    // 覆盖是无条件的：<agentDir>/SYSTEM.md 存在也不采纳，系统提示词只有 KyDog 一个来源。
    const systemPrompt = await buildKydogSystemPrompt(projectCwd);
    return new pi.DefaultResourceLoader({
      cwd: projectCwd,
      agentDir: kydogAgentDir(),
      systemPromptOverride: () => systemPrompt,
      noSkills: true,
      // 从磁盘发现的扩展（agentDir/extensions、项目 .pi/extensions、pi settings 声明的
      // packages）一律不加载 —— KyDog 一个都没有，加载进来的只会是环境里别人的东西。
      // 不影响 extensionFactories：inline factory 走 loadExtensionFactories()，另一条路。
      noExtensions: true,
      additionalSkillPaths: [KYDOG_SKILLS_DIR],
      skillsOverride: buildSkillsOverride(disabled),
      agentsFilesOverride: buildAgentsFilesOverride(harness),
      extensionFactories: [askBatchFactory],
    });
  });
}
