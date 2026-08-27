// src/main/skills/skillSyncStateHolder.ts
import path from 'node:path';
import { app } from 'electron';
import { runSkillSync } from './skillSync';
import { builtinSkillsRoot } from './builtinSkills';
import type { SkillLocale } from './localeProjection';
import { KYDOG_SKILLS_DIR } from './skillResourceLoader';
import { STAGING_DIR } from '../persist/paths';
import { logger } from '../log';
import type { SkillSyncHealth, SyncPhase } from '../../shared/types';
import { withSkillTree } from './skillTreeLock';

const MANIFEST = path.join(KYDOG_SKILLS_DIR, '.manifest.json');
// 暂存必须与 KYDOG_SKILLS_DIR 同卷（都在 ~/.kydog 下），否则 replaceSkillTree 的 rename 会 EXDEV。
const SKILL_STAGING = path.join(STAGING_DIR, 'skills');

let cached: SkillSyncHealth | null = null;

export const skillSyncStateHolder = {
  // locale 由调用方显式传入（启动流程读 settings.ui.locale；onboarding 传刚写进 manifest 的那个），
  // 这里不再自己兜底读取 —— onboarding 完成前 settings 还没落盘，读到的是旧值。
  async runFor(locale: SkillLocale, phase: SyncPhase): Promise<void> {
    await withSkillTree(() => this.runForUnlocked(locale, phase));
  },

  // 无锁实现，给已经持锁的调用方用（如 locale.set）；runFor() 是加锁壳，给启动流程 / onboarding 用。
  // 别在已持锁的方法体内调用 runFor()——那是重入死锁，应该调这个。
  // 返回这一次的结果而不是让调用方回头读 getHealth()：locale.set 要按「这次」成没成决定提交还是重投影，
  // 而 cached 会被随后的重投影覆盖，读回来的就不是同一件事了。
  async runForUnlocked(locale: SkillLocale, phase: SyncPhase): Promise<SkillSyncHealth> {
    cached = await runSkillSync({
      builtinRoot: builtinSkillsRoot(),
      skillsDir: KYDOG_SKILLS_DIR,
      manifestPath: MANIFEST,
      stagingRoot: SKILL_STAGING,
      locale, phase,
      kydogVersion: app.getVersion(),
    });
    // runSkillSync 不抛，失败只体现在返回值里 —— 不在这儿记一笔就彻底没声音了。
    if (cached.state === 'failed') {
      logger.warn('skill-sync', 'sync failed', { phase: cached.phase, skill: cached.skill, message: cached.message });
    }
    return cached;
  },
  getHealth(): SkillSyncHealth {
    // 还没跑过：onboarding 未完成时启动流程走不到同步这一步。
    return cached ?? { state: 'skipped', reason: 'onboarding-pending' };
  },
};
