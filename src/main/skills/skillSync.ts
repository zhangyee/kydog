import { promises as fsp, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { sha256OfFile } from './sha';
import { hashProjectedSkill, listSkillSourceFiles, listBuiltinSkills } from './builtinSkills';
import { projectSkillFiles, type SkillLocale } from './localeProjection';
import { replaceSkillTree } from './replaceSkillTree';
import { readManifest, writeManifest } from './manifest';
import { assertSafeSkillName } from './safeRel';
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
  try {
    const scan = scanSkillDir(skillDir);
    if (scan.kind === 'alien') return true;
    const onDisk = new Set(scan.rels);
    const want = Object.keys(shipped);
    if (onDisk.size !== want.length) return true;          // 有多余文件也要重写
    for (const rel of want) {
      if (!onDisk.has(rel)) return true;
      if (sha256OfFile(path.join(skillDir, rel)) !== shipped[rel]) return true;
    }
    return false;
  } catch {
    // 磁盘侧读不动（权限、竞态改动……）就当成需要重写：判不出来时重写是安全的一侧，
    // 整棵原子替换本来就会把那里换成已知状态；抛出去则会停掉整轮同步。
    // 真换不动的话 replaceSkillTree 会失败，那时才报 failed，且带得上是哪个 skill。
    return true;
  }
}

/** 磁盘现状：普通文件的相对路径列表，或者「撞见了不该在这儿的东西」。 */
type DiskScan = { kind: 'files'; rels: string[] } | { kind: 'alien' };

/**
 * 软链必须显式判掉，不能靠「它既非 file 也非 directory 所以自然被漏掉」——
 * `Dirent.isDirectory()` 对软链返回 false，它走的是 else 分支，会被当成普通文件收进来，
 * 随后 sha256OfFile 读断链是 ENOENT、读目录链是 EISDIR，整轮同步就此停摆。
 * 用户会在 Finder 里动这棵树，软链是预期内会出现的东西，不是异常。
 */
function scanSkillDir(dir: string): DiskScan {
  const rels: string[] = [];
  const walk = (rel: string): boolean => {
    for (const e of readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!walk(child)) return false; }
      else if (e.isFile()) rels.push(child);
      else return false;             // 软链/设备/FIFO：不是我们发出去的东西 → 整棵换掉
    }
    return true;
  };
  return walk('') ? { kind: 'files', rels } : { kind: 'alien' };
}

export async function runSkillSync(i: SyncInputs): Promise<SkillSyncHealth> {
  try {
    await fsp.mkdir(i.skillsDir, { recursive: true });
    const builtinNames = listBuiltinSkills(i.builtinRoot);
    const prior = await readManifest(i.manifestPath);

    // 源侧一个内置 skill 都列不出来，而 manifest 记过：`listBuiltinSkills` 在 root 不存在时
    // 返回空数组，所以这说明源读不到（资源目录缺失、卷没挂上），**不是**「内置 skill 全被下架了」。
    // 照常往下走的后果是数据丢失：孤儿清理会把 manifest 记过的每个目录 `rm -rf` 删光，
    // 随后写一份空 manifest 覆盖历史，最后还返回 ok —— 静默删光内置 skill 并报告健康。
    // 判不出来时什么都不做才是安全的一侧，让 Settings 有东西可显示。
    if (builtinNames.length === 0 && prior.kind === 'ok' && prior.builtin.length > 0) {
      return {
        state: 'failed', phase: i.phase,
        message: `内置 skill 源目录列不出任何 skill（${i.builtinRoot}），本轮跳过同步与清理`,
      };
    }

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
        // 名字来自 manifest 这份可编辑、可损坏的 JSON，而 readManifest 只校验类型不校验取值。
        // 递归删除之前必须过闸口：`"."` 会让目标退回 skillsDir 本身、把用户自己装的
        // skill 一起删光，`"../x"` 直接删到目录外面去。
        try {
          assertSafeSkillName(name, 'manifest orphan cleanup');
        } catch (err) {
          logger.warn('skill-sync', 'unsafe name in manifest, orphan skipped', { name, err: String(err) });
          continue;
        }
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
