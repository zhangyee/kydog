import soulZh from './templates/zh/SOUL.md?raw';
import userZh from './templates/zh/USER.md?raw';
import agentsZh from './templates/zh/AGENTS.md?raw';
import soulEn from './templates/en/SOUL.md?raw';
import userEn from './templates/en/USER.md?raw';
import agentsEn from './templates/en/AGENTS.md?raw';

export type HarnessLocale = 'zh' | 'en';
export type HarnessTemplates = { soul: string; user: string; agents: string };

const TEMPLATES: Record<HarnessLocale, HarnessTemplates> = {
  zh: { soul: soulZh, user: userZh, agents: agentsZh },
  en: { soul: soulEn, user: userEn, agents: agentsEn },
};

export function harnessTemplates(locale: HarnessLocale): HarnessTemplates {
  return TEMPLATES[locale];
}
