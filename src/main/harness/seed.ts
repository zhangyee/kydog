import { promises as fsp } from 'node:fs';
import path from 'node:path';
import * as paths from '../persist/paths';
import { harnessTemplates, type HarnessLocale } from './templates';
import { logger } from '../log';

export type SeedInput = { locale: HarnessLocale; userName: string; agentName: string };
export type SeedOutcome = { created: string[]; skipped: string[] };

/** front matter 内占位符用 JSON.stringify（合法 YAML 双引号标量），正文用原值（spec §9.1）。 */
export function renderTemplate(tpl: string, names: { userName: string; agentName: string }): string {
  const sub = (s: string, enc: (v: string) => string) =>
    s.replaceAll('{{userName}}', enc(names.userName)).replaceAll('{{agentName}}', enc(names.agentName));
  const m = /^---\n[\s\S]*?\n---\n/.exec(tpl);
  if (!m) return sub(tpl, (v) => v);
  return sub(m[0], (v) => JSON.stringify(v)) + sub(tpl.slice(m[0].length), (v) => v);
}

export async function seedHarnessFiles(input: SeedInput, dir: string = paths.ROOT): Promise<SeedOutcome> {
  const t = harnessTemplates(input.locale);
  const files: Array<[string, string]> = [
    ['SOUL.md', renderTemplate(t.soul, input)],
    ['USER.md', renderTemplate(t.user, input)],
    ['AGENTS.md', renderTemplate(t.agents, input)],
  ];
  const created: string[] = [];
  const skipped: string[] = [];
  for (const [name, content] of files) {
    try {
      await fsp.writeFile(path.join(dir, name), content, { encoding: 'utf8', flag: 'wx' });
      created.push(name);
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') { skipped.push(name); continue; }
      throw err;
    }
  }
  logger.info('harness.seed', 'seeded', { created, skipped, locale: input.locale });
  return { created, skipped };
}
