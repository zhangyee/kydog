import { promises as fsp } from 'node:fs';
import path from 'node:path';
import * as paths from '../persist/paths';
import { harnessTemplate, type HarnessLocale } from './templates';
import { readHarnessState, writeHarnessState, withHarnessLock } from './harnessState';
import { HARNESS_FILE_NAMES, type HarnessFileName } from '../../shared/types';
import { logger } from '../log';

export type SeedInput = { locale: HarnessLocale; userName: string; agentName: string };
export type SeedOutcome = { created: string[]; skipped: string[] };

/** front matter 内占位符用 JSON.stringify（合法 YAML 双引号标量），正文用原值（spec §9.1）。 */
export function renderTemplate(tpl: string, names: { userName: string; agentName: string }): string {
  const sub = (s: string, enc: (v: string) => string) =>
    s.replaceAll('{{userName}}', enc(names.userName)).replaceAll('{{agentName}}', enc(names.agentName));
  // 围栏认 \r\n：模板是 ?raw 进来的签出内容，Windows 的 core.autocrlf 会把它变成
  // CRLF。只认 \n 的话 front matter 认不出来，会掉进下面的原值分支静默写坏 YAML。
  const m = /^---\r?\n[\s\S]*?\n---\r?\n/.exec(tpl);
  if (!m) return sub(tpl, (v) => v);
  return sub(m[0], (v) => JSON.stringify(v)) + sub(tpl.slice(m[0].length), (v) => v);
}

export async function seedHarnessFiles(input: SeedInput, dir: string = paths.ROOT): Promise<SeedOutcome> {
  const files: Array<[HarnessFileName, string]> = HARNESS_FILE_NAMES.map((name) => [name, harnessTemplate(input.locale, name)]);
  const created: HarnessFileName[] = [];
  const skipped: HarnessFileName[] = [];
  for (const [name, tpl] of files) {
    try {
      await fsp.writeFile(path.join(dir, name), renderTemplate(tpl, input), { encoding: 'utf8', flag: 'wx' });
      created.push(name);
    } catch (err) {
      if ((err as { code?: string }).code === 'EEXIST') { skipped.push(name); continue; }
      throw err;
    }
  }
  // 只为这次创建的记「写入时用的模板」（spec §3.3）；EEXIST 跳过的交给启动判定的 R1 / R4。
  // 记不进去不让引导失败：文件已经等于当前模板，R1 下次会补记。
  if (created.length > 0) {
    try {
      await withHarnessLock(async () => {
        const s = await readHarnessState(dir);
        for (const [name, tpl] of files) {
          if (created.includes(name)) s.files[name] = { locale: input.locale, template: tpl, keptTemplateSha: null };
        }
        await writeHarnessState(s, dir);
      });
    } catch (err) {
      logger.warn('harness.seed', 'record state failed', { err: String(err) });
    }
  }
  logger.info('harness.seed', 'seeded', { created, skipped, locale: input.locale });
  return { created, skipped };
}
