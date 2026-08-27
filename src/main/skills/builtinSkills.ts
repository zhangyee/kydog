import path from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { app } from 'electron';
import { sha256OfFile } from './sha';
import { projectSkillFiles, type SkillLocale } from './localeProjection';

function liveRepoRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

/**
 * Resolve where built-in skills live for the running mode.
 * dev → <repo>/src/skills
 * packaged → <resourcesPath>/skills (placed there by forge `extraResource: ['src/skills']`)
 */
export function builtinSkillsRoot(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'skills')
    : path.join(liveRepoRoot(), 'src', 'skills');
}

export function listBuiltinSkills(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(root, e.name, 'SKILL.md')))
    .map((e) => e.name)
    .sort();
}

/** 递归列出 skill 源目录下全部普通文件的相对路径（含 .en 变体）。 */
export function listSkillSourceFiles(root: string, name: string): string[] {
  const out: string[] = [];
  walk(path.join(root, name), '', out);
  return out;
}

function walk(absRoot: string, relPath: string, out: string[]): void {
  const here = relPath ? path.join(absRoot, relPath) : absRoot;
  for (const entry of readdirSync(here, { withFileTypes: true })) {
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(absRoot, childRel, out);
    else if (entry.isFile()) out.push(childRel);
    // 软链/设备/FIFO：源在仓库里，出现即是错误，报错中止而不是静默跳过 ——
    // 跳过的话它只是从投影树里消失，落盘少一个文件，没有任何人会发现。
    else throw new Error(`${path.join(absRoot, childRel)} is not a regular file`);
  }
}

/**
 * `{ 投影后路径: 被选中那个源文件的 sha256 }`。
 *
 * key 用投影后路径而非源路径是刻意的：上游后来补了 `SKILL.en.md`、投影源从 A 换成 B 时，
 * 这在 sha 层面就是一次普通的「源变了」，两方比对原样能处理；
 * key 若用源路径，同一个落盘文件会在两次 sync 之间换 key，比对就失准了。
 */
export function hashProjectedSkill(root: string, name: string, locale: SkillLocale): Record<string, string> {
  const projection = projectSkillFiles(listSkillSourceFiles(root, name), locale);
  const out: Record<string, string> = {};
  for (const [projRel, srcRel] of projection) {
    out[projRel] = sha256OfFile(path.join(root, name, srcRel));
  }
  return out;
}
