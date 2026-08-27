// src/main/skills/skillSyncStateHolder.ts
import path from 'node:path';
import { app } from 'electron';
import { runSkillSync } from './skillSync';
import { builtinSkillsRoot } from './builtinSkills';
import { DEFAULT_SKILL_LOCALE, type SkillLocale } from './localeProjection';
import { KYDOG_SKILLS_DIR } from './skillResourceLoader';
import { STAGING_DIR } from '../persist/paths';
import { settingsService } from '../settings/settingsService';
import { logger } from '../log';
import type { SkillSyncHealth, SyncPhase } from '../../shared/types';

const MANIFEST = path.join(KYDOG_SKILLS_DIR, '.manifest.json');
// 暂存必须与 KYDOG_SKILLS_DIR 同卷（都在 ~/.kydog 下），否则 replaceSkillTree 的 rename 会 EXDEV。
const SKILL_STAGING = path.join(STAGING_DIR, 'skills');

let cached: SkillSyncHealth | null = null;

/** 落盘语言取自 settings.ui.locale：界面说什么话，skill 就该是什么话。 */
async function currentLocale(): Promise<SkillLocale> {
  try {
    return (await settingsService.get()).ui.locale;
  } catch (err) {
    logger.warn('skill-sync', 'locale unreadable, using default', { err: String(err) });
    return DEFAULT_SKILL_LOCALE;
  }
}

async function run(phase: SyncPhase): Promise<void> {
  cached = await runSkillSync({
    builtinRoot: builtinSkillsRoot(),
    skillsDir: KYDOG_SKILLS_DIR,
    manifestPath: MANIFEST,
    stagingRoot: SKILL_STAGING,
    locale: await currentLocale(),
    phase,
    kydogVersion: app.getVersion(),
  });
  // runSkillSync 不抛，失败只体现在返回值里 —— 不在这儿记一笔就彻底没声音了。
  if (cached.state === 'failed') {
    logger.warn('skill-sync', 'sync failed', { phase: cached.phase, skill: cached.skill, message: cached.message });
  }
}

export const skillSyncStateHolder = {
  async runOnStartup(): Promise<void> {
    await run('startup');
  },
  getHealth(): SkillSyncHealth {
    // 还没跑过：onboarding 未完成时启动流程走不到同步这一步。
    return cached ?? { state: 'skipped', reason: 'onboarding-pending' };
  },
};
