import type { HarnessApplyResult, HarnessChoice, HarnessEditState, HarnessFileName, HarnessFileStatus } from '../../shared/types';

/** 启动对话框与长期记忆页共用的文案（spec §6.1 / §6.3），两处说法不许漂移。 */

export const HARNESS_FILE_ROLE: Record<HarnessFileName, string> = {
  'SOUL.md': '人格',
  'USER.md': '用户',
  'AGENTS.md': '操作手册',
};

const LOCALE_NAME = { zh: '中文版', en: '英文版' } as const;

const EDIT_LINE: Record<HarnessEditState, string> = {
  unchanged: '写入后没改过，更新不会丢失任何内容',
  edited: '写入后改过（可能是你，也可能是 KyDog 按你的要求改的），更新前会备份',
  unknown: '无法确认是否改过（这个版本之前没有记录），更新前会备份',
};

/** 「更新会不会丢东西」那一句；语言换了再补一句新模板是哪一版。 */
export function editStateLine(s: Pick<HarnessFileStatus, 'edit' | 'localeDiffers' | 'templateLocale'>): string {
  const base = s.edit ? EDIT_LINE[s.edit] : '';
  if (!s.localeDiffers) return base;
  const tail = `新模板是${LOCALE_NAME[s.templateLocale]}`;
  return base ? `${base}；${tail}` : tail;
}

export function templateStateLabel(s: Pick<HarnessFileStatus, 'template' | 'localeDiffers' | 'templateLocale'>): string {
  switch (s.template) {
    case 'latest': return '已是最新';
    case 'missing': return '文件不存在';
    case 'kept': return '有新版本（你选过保持）';
    case 'available': return s.localeDiffers ? `有新版本（${LOCALE_NAME[s.templateLocale]}）` : '有新版本';
  }
}

export function applyResultLine(r: HarnessApplyResult, choice: HarnessChoice['choice']): string {
  if (r.outcome === 'kept') return '已保持，这一版不再询问';
  if (r.outcome === 'updated') return r.backupName ? `已更新，旧文件备份为 ~/.kydog/${r.backupName}` : '已创建';
  return choice === 'keep' ? `没能记下「保持」：${r.error}` : `更新失败：${r.error}，原文件没有改动`;
}
