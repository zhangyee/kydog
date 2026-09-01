import soulZh from './templates/zh/SOUL.md?raw';
import userZh from './templates/zh/USER.md?raw';
import agentsZh from './templates/zh/AGENTS.md?raw';
import soulEn from './templates/en/SOUL.md?raw';
import userEn from './templates/en/USER.md?raw';
import agentsEn from './templates/en/AGENTS.md?raw';

export type HarnessLocale = 'zh' | 'en';
export type HarnessTemplates = { soul: string; user: string; agents: string };

/**
 * ?raw 拿到的是磁盘字节：同一份模板在 LF 检出下是 LF，在 Windows（core.autocrlf）下是 CRLF。
 * 行尾是检出噪声、不是模板内容，在入口处一次归一化 —— 下游的 front matter 解析与落盘结果
 * 因此跨平台一致，不用各自去猜行尾。与 renderer 侧 about/aboutDoc.ts 的做法保持一致。
 */
const lf = (s: string) => s.replace(/\r\n/g, '\n');

const TEMPLATES: Record<HarnessLocale, HarnessTemplates> = {
  zh: { soul: lf(soulZh), user: lf(userZh), agents: lf(agentsZh) },
  en: { soul: lf(soulEn), user: lf(userEn), agents: lf(agentsEn) },
};

export function harnessTemplates(locale: HarnessLocale): HarnessTemplates {
  return TEMPLATES[locale];
}
