// src/main/skills/skillSyncStateHolder.ts
import path from 'node:path';
import { app } from 'electron';
import { runSkillSync, applyOverrides as applyOverridesImpl, type SyncResult } from './skillSync';
import { builtinSkillsRoot } from './builtinSkills';
import { KYDOG_SKILLS_DIR } from './skillResourceLoader';
import type { SkillSyncStatus } from '../../shared/types';

const MANIFEST = path.join(KYDOG_SKILLS_DIR, '.manifest.json');

let cached: SyncResult | null = null;

export const skillSyncStateHolder = {
  async runOnStartup(): Promise<void> {
    cached = await runSkillSync({
      builtinRoot: builtinSkillsRoot(),
      kydogSkillsDir: KYDOG_SKILLS_DIR,
      manifestPath: MANIFEST,
      kydogVersion: app.getVersion(),
    });
  },
  getStatus(): SkillSyncStatus {
    if (!cached) return { installedOrUpgraded: [], pendingConflicts: [], userSkills: [] };
    return {
      installedOrUpgraded: cached.installedOrUpgraded,
      pendingConflicts: cached.pendingConflicts,
      userSkills: cached.userSkills,
    };
  },
  async applyOverrides(operations: { skill: string; files: string[] }[]): Promise<void> {
    await applyOverridesImpl({
      builtinRoot: builtinSkillsRoot(),
      kydogSkillsDir: KYDOG_SKILLS_DIR,
      manifestPath: MANIFEST,
      kydogVersion: app.getVersion(),
      operations,
    });
    // After overrides, those files are no longer conflicting; refresh.
    await this.runOnStartup();
  },
};
