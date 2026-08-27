import type {
  LocaleSetOutcome, SettingsFile, SkillEntry, SkillSyncFailed, SkillSyncHealth, SyncPhase,
} from '../../shared/types';
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

export type LocaleSetResult = { settings: SettingsFile; skills: SkillEntry[]; outcome: LocaleSetOutcome };

/**
 * 语言切换必须是一个 RPC 而不是两个。
 * 拆成「先 settings.update 再单独调 sync」有两个真实缺陷：两次调用之间创建的 session 会
 * 快照到旧 skill 树；sync 失败会留下 locale=en 而磁盘是中文的长期不一致。
 *
 * 调用方负责持有 skillTreeLock —— 这里不自己加锁，否则内部的 sync/listSkills 会死锁。
 */
export function createLocaleSet(deps: LocaleSetDeps) {
  return async (locale: SkillLocale): Promise<LocaleSetResult> => {
    const settled = async (outcome: LocaleSetOutcome): Promise<LocaleSetResult> =>
      ({ settings: await deps.readSettings(), skills: await deps.listSkills(), outcome });

    const previous = await deps.currentLocale();
    // 没跑同步，就不产生 SkillSyncHealth —— 编一个 ok 出来会盖掉磁盘的真实健康度。
    if (previous === locale) return settled({ kind: 'unchanged' });

    // pi 的 skill 正文是调用时现读磁盘的：旧 session 换完树会变成「旧 description + 新正文」。
    // 锁挡不住模型手里的 read 工具，所以这里只能靠「切换时没有 run 在跑」这个前提。
    //
    // 这是**业务拒绝**，不是同步失败：下面三样一个都没动过（dispose / sync / commitLocale），
    // skill 树与 settings 都还是原样。所以走 rejected 而不是 failed。
    if (deps.hasActiveRun()) {
      return settled({ kind: 'rejected', message: '有任务正在运行，请等它结束后再切换语言' });
    }

    await deps.disposeAllSessions();

    // 向前重投影：源就是备份，按旧 locale 重跑一次即可精确还原。
    // 不做 backup handle 的逆序回滚 —— 那要管备份的生命周期，还会出现「清理备份时部分删除成功」。
    const restoreAndReport = async (failure: SkillSyncFailed): Promise<LocaleSetResult> => {
      const restored = await deps.sync(previous, 'locale-switch');
      if (restored.state === 'ok') return settled({ kind: 'failed', sync: failure });
      logger.error('locale.set', 'restore failed', {
        previous, locale,
        original: failure.message,
        restore: restored.state === 'failed' ? restored.message : restored.state,
      });
      // 展开原 failure 而不是新造一个：skill 名等诊断信息不该在最坏的分支上反而丢掉。
      return settled({
        kind: 'failed',
        sync: { ...failure, message: `${failure.message}；skill 树可能不一致，重启将自动修复` },
      });
    };

    // 提交顺序：树换成功了才提交 locale。反过来会留下 settings 说英文、磁盘是中文的长期不一致。
    const health = await deps.sync(locale, 'locale-switch');
    if (health.state === 'ok') {
      try {
        await deps.commitLocale(locale);
        return settled({ kind: 'applied', sync: health });
      } catch (err) {
        return restoreAndReport({ state: 'failed', phase: 'locale-switch', message: String(err) });
      }
    }
    if (health.state === 'skipped') {
      // 协议上到不了：locale-switch 这一轮的同步只会返回 ok / failed。真到了也当失败处理，
      // 而不是当成功放行 —— 树的状态未知时，回到旧语言是安全的一侧。
      return restoreAndReport({
        state: 'failed', phase: 'locale-switch', message: `同步未执行（${health.reason}）`,
      });
    }
    return restoreAndReport(health);
  };
}
