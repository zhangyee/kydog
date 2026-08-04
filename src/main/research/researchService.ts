// src/main/research/researchService.ts
import { settingsService } from '../settings/settingsService';
import { normalizeResearch, validateResearch } from '../../shared/researchValidate';
import { applyResearchEnv } from './researchEnv';
import { KydogError } from '../../shared/errors';
import type { SettingsFile } from '../../shared/types';

type Research = SettingsFile['research'];

export const researchService = {
  async get(): Promise<Research> {
    return (await settingsService.get()).research;
  },

  /** 校验 → 落盘 → 写 env。顺序不可颠倒：先写 env 会造成「当前会话生效、重启就没了」。 */
  async save(input: Research): Promise<Research> {
    const normalized = normalizeResearch(input);
    const errors = validateResearch(normalized);
    if (errors.length > 0) {
      throw new KydogError('settings.invalid', errors.map((e) => e.message).join('；'));
    }
    await settingsService.update({ research: normalized });
    applyResearchEnv(normalized);
    return normalized;
  },
};
