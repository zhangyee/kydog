import { createHash } from 'node:crypto';
import { renderTemplate } from './seed';
import type { HarnessEditState, HarnessTemplateState } from '../../shared/types';

/**
 * 一份 harness 文件的状态记录（spec §3.1）。
 * template / locale 同为 null：老用户对某一版选了「保持」，但那份文件当初用哪一版模板写的，
 * 没有任何地方留着 —— 只知道他保持了哪一版，不编一个「写入时的模板」出来。
 */
export type HarnessRecord = {
  locale: 'zh' | 'en' | null;
  /** 写入时用的模板原文（占位符未替换）。 */
  template: string | null;
  /** 对哪一版模板（sha256）选过「保持」。 */
  keptTemplateSha: string | null;
};

export type AssessInput = {
  /** 当前界面语言的当前模板（T）。 */
  template: string;
  /** 当前界面语言（L）。 */
  locale: 'zh' | 'en';
  record: HarnessRecord | null;
  /** 磁盘内容（D）；null = 文件不存在。 */
  disk: string | null;
  names: { userName: string; agentName: string };
};

export type Assessment = {
  template: HarnessTemplateState;
  edit: HarnessEditState | null;
  localeDiffers: boolean;
  /** 非 null 时调用方应把这条写进状态（R1 补记）。 */
  backfill: HarnessRecord | null;
};

export function templateSha(template: string): string {
  return createHash('sha256').update(template, 'utf8').digest('hex');
}

/** 判定表（spec §3.2），按顺序命中即止。纯函数：不碰文件系统。 */
export function assessHarnessFile(input: AssessInput): Assessment {
  const { template: T, locale: L, record: R, disk: D, names } = input;
  if (D === null) return { template: 'missing', edit: null, localeDiffers: false, backfill: null };

  // R1 排最前：文件写成功、状态没写成功时，下次不会拿旧模板比新文件、误判成「改过」。
  if (D === renderTemplate(T, names)) {
    const stale = R === null || R.template !== T || R.locale !== L;
    return { template: 'latest', edit: null, localeDiffers: false, backfill: stale ? { locale: L, template: T, keptTemplateSha: null } : null };
  }
  // R2：从当前模板写入之后又改过 —— 正常编辑，不是「有新版本」。
  if (R !== null && R.template !== null && R.template === T) {
    return { template: 'latest', edit: null, localeDiffers: false, backfill: null };
  }

  // 改动状态靠「写入时的模板 + 当前名字」重渲染后逐字比（决策 6）：只改了名字仍算 unchanged。
  const edit: HarnessEditState = R === null || R.template === null ? 'unknown'
    : D === renderTemplate(R.template, names) ? 'unchanged'
    : 'edited';
  const localeDiffers = R !== null && R.locale !== null && R.locale !== L;
  const kept = R !== null && R.keptTemplateSha === templateSha(T);
  return { template: kept ? 'kept' : 'available', edit, localeDiffers, backfill: null };
}
