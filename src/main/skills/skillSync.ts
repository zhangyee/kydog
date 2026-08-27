import { promises as fsp, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { sha256OfFile } from './sha';
import { hashProjectedSkill, listSkillSourceFiles, listBuiltinSkills } from './builtinSkills';
import { projectSkillFiles, type SkillLocale } from './localeProjection';
import { replaceSkillTree } from './replaceSkillTree';
import { readManifest, writeManifest } from './manifest';
import { logger } from '../log';
import type { SkillSyncHealth, SyncPhase } from '../../shared/types';

export interface SyncInputs {
  builtinRoot: string;
  skillsDir: string;          // ~/.kydog/skills
  manifestPath: string;
  stagingRoot: string;
  locale: SkillLocale;
  phase: SyncPhase;
  kydogVersion: string;
}

/** 投影 vs 磁盘的两方比对：不一致就整棵重写。
 *  不需要「上次发出去的是什么」——三方比对唯一的用途是识别用户改动，而我们不再识别。 */
function needsRewrite(shipped: Record<string, string>, skillDir: string): boolean {
  // 不存在，或那个位置根本不是目录（普通文件、软链）→ 直接整棵重写。
  // 这里不能只判存在：readdirSync 碰上普通文件会 ENOTDIR 抛出去，被外层兜住之后
  // 整轮同步就停了 —— 一个放错位置的文件让所有内置 skill 不再更新。
  // replaceSkillTree 的 rename 换得掉文件与软链，交给它就行。
  if (!lstatSync(skillDir, { throwIfNoEntry: false })?.isDirectory()) return true;
  const onDisk = new Set(listExistingRels(skillDir));
  const want = Object.keys(shipped);
  if (onDisk.size !== want.length) return true;          // 有多余文件也要重写
  for (const rel of want) {
    if (!onDisk.has(rel)) return true;
    if (sha256OfFile(path.join(skillDir, rel)) !== shipped[rel]) return true;
  }
  return false;
}

function listExistingRels(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(child);
      else out.push(child);          // 软链在这里既非 file 也非 directory，天然被漏掉 → 触发重写
    }
  };
  walk('');
  return out;
}

export async function runSkillSync(i: SyncInputs): Promise<SkillSyncHealth> {
  try {
    await fsp.mkdir(i.skillsDir, { recursive: true });
    const builtinNames = listBuiltinSkills(i.builtinRoot);
    const prior = await readManifest(i.manifestPath);
    const installedOrUpgraded: string[] = [];

    for (const name of builtinNames) {
      const shipped = hashProjectedSkill(i.builtinRoot, name, i.locale);
      const skillDir = path.join(i.skillsDir, name);
      if (!needsRewrite(shipped, skillDir)) continue;
      const projection = projectSkillFiles(listSkillSourceFiles(i.builtinRoot, name), i.locale);
      try {
        await replaceSkillTree({
          srcRoot: i.builtinRoot, skillName: name, projection,
          targetDir: skillDir, stagingRoot: i.stagingRoot,
        });
      } catch (err) {
        return { state: 'failed', phase: i.phase, skill: name, message: String(err) };
      }
      installedOrUpgraded.push(name);
    }

    // 孤儿清理：manifest 记过、当前已不是 builtin 的目录。
    // 历史列表未知时跳过而不是猜 —— 误删用户自己装的 skill 比留下一个旧目录严重得多。
    if (prior.kind === 'ok') {
      for (const name of prior.builtin) {
        if (builtinNames.includes(name)) continue;
        await fsp.rm(path.join(i.skillsDir, name), { recursive: true, force: true });
      }
    } else {
      logger.warn('skill-sync', 'manifest unreadable, orphan cleanup skipped', { path: i.manifestPath });
    }

    await writeManifest(i.manifestPath, {
      schemaVersion: 2, kydogVersion: i.kydogVersion,
      writtenAt: new Date().toISOString(), builtin: builtinNames,
    });

    const userSkills = readdirSync(i.skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !builtinNames.includes(e.name))
      .map((e) => e.name)
      .sort();

    return { state: 'ok', installedOrUpgraded, userSkills };
  } catch (err) {
    return { state: 'failed', phase: i.phase, message: String(err) };
  }
}
