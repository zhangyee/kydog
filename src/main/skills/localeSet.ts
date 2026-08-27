import type { SettingsFile, SkillEntry, SkillSyncHealth, SyncPhase } from '../../shared/types';
import type { SkillLocale } from './localeProjection';
import { logger } from '../log';

export interface LocaleSetDeps {
  currentLocale: () => Promise<SkillLocale>;
  hasActiveRun: () => boolean;
  disposeAllSessions: () => Promise<void>;
  sync: (locale: SkillLocale, phase: SyncPhase) => Promise<SkillSyncHealth>;
  commitLocale: (locale: SkillLocale) => Promise<SettingsFile>;
  readSettings: () => Promise<SettingsFile>;
  listSkills: () => Promise<SkillEntry[]>;
}

export type LocaleSetResult = { settings: SettingsFile; skills: SkillEntry[]; sync: SkillSyncHealth };

/**
 * 语言切换必须是一个 RPC 而不是两个。
 * 拆成「先 settings.update 再单独调 sync」有两个真实缺陷：两次调用之间创建的 session 会
 * 快照到旧 skill 树；sync 失败会留下 locale=en 而磁盘是中文的长期不一致。
 *
 * 调用方负责持有 skillTreeLock —— 这里不自己加锁，否则内部的 sync/listSkills 会死锁。
 */
export function createLocaleSet(deps: LocaleSetDeps) {
  return async (locale: SkillLocale): Promise<LocaleSetResult> => {
    const settled = async (sync: SkillSyncHealth): Promise<LocaleSetResult> =>
      ({ settings: await deps.readSettings(), skills: await deps.listSkills(), sync });

    const previous = await deps.currentLocale();
    if (previous === locale) return settled({ state: 'ok', installedOrUpgraded: [], userSkills: [] });

    // pi 的 skill 正文是调用时现读磁盘的：旧 session 换完树会变成「旧 description + 新正文」。
    // 锁挡不住模型手里的 read 工具，所以这里只能靠「切换时没有 run 在跑」这个前提。
    if (deps.hasActiveRun()) {
      return settled({
        state: 'failed', phase: 'locale-switch',
        message: '有任务正在运行，请等它结束后再切换语言',
      });
    }

    await deps.disposeAllSessions();

    // 提交顺序：树换成功了才提交 locale。反过来会留下 settings 说英文、磁盘是中文的长期不一致。
    let health = await deps.sync(locale, 'locale-switch');
    if (health.state === 'ok') {
      try {
        await deps.commitLocale(locale);
        return settled(health);
      } catch (err) {
        health = { state: 'failed', phase: 'locale-switch', message: String(err) };
      }
    }

    // 向前重投影：源就是备份，按旧 locale 重跑一次即可精确还原。
    // 不做 backup handle 的逆序回滚 —— 那要管备份的生命周期，还会出现「清理备份时部分删除成功」。
    const restored = await deps.sync(previous, 'locale-switch');
    if (restored.state !== 'ok') {
      logger.error('locale.set', 'restore failed', { previous, locale });
      return settled({
        state: 'failed', phase: 'locale-switch',
        message: `${health.state === 'failed' ? health.message : ''}；skill 树可能不一致，重启将自动修复`,
      });
    }
    return settled(health);
  };
}
