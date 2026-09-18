import { promises as fsp, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import * as paths from '../persist/paths';
import { atomicWrite } from '../persist/atomicWrite';
import { settingsService } from '../settings/settingsService';
import { getIdentity } from './identityService';
import { harnessTemplate } from './templates';
import { renderTemplate } from './seed';
import { assessHarnessFile, templateSha } from './harnessAssess';
import { readHarnessState, writeHarnessState, withHarnessLock, type HarnessState } from './harnessState';
import { splitFrontmatter } from './frontmatter';
import { logger } from '../log';
import {
  HARNESS_FILE_NAMES, HARNESS_APPLY_SOURCES,
  type HarnessApplyResult, type HarnessApplySource, type HarnessChoice, type HarnessFileName, type HarnessFileStatus,
  type HarnessReadResult, type HarnessWriteResult, type Identity,
} from '../../shared/types';

export type HarnessServiceDeps = {
  dir: string;
  /** 当前界面语言（settings.ui.locale）。 */
  getLocale: () => Promise<'zh' | 'en'>;
  /** 渲染模板用的称呼，与界面上显示的同源（spec §3.1）。 */
  getNames: () => Promise<Identity>;
  now: () => Date;
};

/** IPC 进来的参数类型系统管不到：只认三个确切文件名，别的（含路径）一律拒绝。 */
function assertName(name: unknown): asserts name is HarnessFileName {
  if (!(HARNESS_FILE_NAMES as readonly unknown[]).includes(name)) throw new Error(`不认识的 harness 文件：${String(name)}`);
}

async function readOrNull(file: string): Promise<string | null> {
  try { return await fsp.readFile(file, 'utf8'); }
  catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null;
    throw err;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 复制成 `<name>.bak-YYYY-MM-DD`（本地日期），重名依次 -2、-3…；独占创建，绝不覆盖已有备份。返回备份文件名。 */
async function backup(dir: string, name: HarnessFileName, now: Date): Promise<string> {
  const stem = `${name}.bak-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  for (let i = 1; i <= 100; i++) {
    const bak = i === 1 ? stem : `${stem}-${i}`;
    try {
      await fsp.copyFile(path.join(dir, name), path.join(dir, bak), fsConstants.COPYFILE_EXCL);
      return bak;
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(`${stem} 起的备份名都已被占用`);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createHarnessService(deps: HarnessServiceDeps) {
  const file = (name: HarnessFileName) => path.join(deps.dir, name);

  /** 状态写失败不影响已经做成的事：R1 下次启动会补记（spec §5.1 第 3 步）。 */
  async function saveState(s: HarnessState, why: string): Promise<void> {
    try { await writeHarnessState(s, deps.dir); }
    catch (err) { logger.warn('harness.state', 'write failed', { why, err: String(err) }); }
  }

  return {
    status(): Promise<{ files: HarnessFileStatus[] }> {
      return withHarnessLock(async () => {
        const [locale, names, state] = await Promise.all([deps.getLocale(), deps.getNames(), readHarnessState(deps.dir)]);
        const files: HarnessFileStatus[] = [];
        let backfilled = false;
        for (const name of HARNESS_FILE_NAMES) {
          const a = assessHarnessFile({
            template: harnessTemplate(locale, name), locale, names,
            record: state.files[name] ?? null,
            disk: await readOrNull(file(name)),
          });
          if (a.backfill) { state.files[name] = a.backfill; backfilled = true; }
          files.push({ name, template: a.template, edit: a.edit, templateLocale: locale, localeDiffers: a.localeDiffers });
        }
        if (backfilled) await saveState(state, 'backfill');
        return { files };
      });
    },

    async apply(choices: HarnessChoice[], source: HarnessApplySource): Promise<{ results: HarnessApplyResult[] }> {
      if (!(HARNESS_APPLY_SOURCES as readonly unknown[]).includes(source)) throw new Error(`不认识的来源：${String(source)}`);
      for (const c of choices) {
        assertName(c?.name);
        if (c.choice !== 'update' && c.choice !== 'keep') throw new Error(`不认识的选择：${String(c.choice)}`);
      }
      return withHarnessLock(async () => {
        const [locale, names, state] = await Promise.all([deps.getLocale(), deps.getNames(), readHarnessState(deps.dir)]);
        const results: HarnessApplyResult[] = [];
        // 三份各自独立：一份失败不影响另外两份（spec §5.4）。
        for (const { name, choice } of choices) {
          const tpl = harnessTemplate(locale, name);
          if (choice === 'keep') {
            const prev = state.files[name];
            // 老用户没有记录：不知道当初用哪一版写的，就不编（spec §3.1），只记保持了哪一版。
            state.files[name] = { ...(prev ?? { locale: null, template: null }), keptTemplateSha: templateSha(tpl) };
            try {
              await writeHarnessState(state, deps.dir);
              logger.info('harness.keep', 'kept', { name, source });
              results.push({ name, outcome: 'kept' });
            } catch (err) {
              if (prev) state.files[name] = prev; else delete state.files[name];
              results.push({ name, outcome: 'failed', error: message(err) });
            }
            continue;
          }
          let backupName: string | null = null;
          try {
            // 更新不复核判定：latest 的点了也照做，missing 的就是创建（spec §7.2）。
            if ((await readOrNull(file(name))) !== null) backupName = await backup(deps.dir, name, deps.now());
          } catch (err) {
            results.push({ name, outcome: 'failed', error: `备份失败：${message(err)}` });
            continue;
          }
          try {
            await atomicWrite(file(name), renderTemplate(tpl, names));
          } catch (err) {
            results.push({ name, outcome: 'failed', error: message(err) });
            continue;
          }
          state.files[name] = { locale, template: tpl, keptTemplateSha: null };
          await saveState(state, 'update');
          logger.info('harness.update', 'updated', { name, locale, backupName, source });
          results.push({ name, outcome: 'updated', backupName });
        }
        return { results };
      });
    },

    async read(name: HarnessFileName): Promise<HarnessReadResult> {
      assertName(name);
      const content = await readOrNull(file(name));
      if (content === null) return { exists: false };
      const { name: frontmatterName, body } = await splitFrontmatter(content);
      return { exists: true, content, frontmatterName, body };
    },

    /** 比较后写：磁盘现内容不等于 expected 就不写（这期间 agent 可能按用户要求改过它）。 */
    async write(args: { name: HarnessFileName; content: string; expected: string | null }): Promise<HarnessWriteResult> {
      assertName(args?.name);
      if (typeof args.content !== 'string' || (args.expected !== null && typeof args.expected !== 'string')) {
        throw new Error('harness.write 参数不合法');
      }
      return withHarnessLock(async () => {
        const disk = await readOrNull(file(args.name));
        if (disk !== args.expected) return { ok: false, diskContent: disk };
        await atomicWrite(file(args.name), args.content);
        return { ok: true };
      });
    },
  };
}

export const harnessService = createHarnessService({
  dir: paths.ROOT,
  getLocale: async () => (await settingsService.get()).ui.locale,
  getNames: () => getIdentity(),
  now: () => new Date(),
});
