import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { KydogError } from '../../shared/errors';
import type { SkillCandidate } from '../../shared/types';
import { parseSkillFrontmatter } from './parseSkillFrontmatter';

export type EnumerateResult = { candidates: SkillCandidate[] };

export async function enumerateSkills(baseDir: string): Promise<EnumerateResult> {
  const direct = await tryDir(baseDir, '');
  if (direct) return { candidates: [direct] };

  const oneLevel = await listChildSkills(baseDir, '');
  if (oneLevel.length > 0) return { candidates: oneLevel };

  // Try unwrap one level
  const subdirs = readdirSync(baseDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'));
  if (subdirs.length === 1) {
    const wrap = subdirs[0].name;
    const wrapPath = path.join(baseDir, wrap);
    const wrapDirect = await tryDir(wrapPath, wrap);
    if (wrapDirect) return { candidates: [wrapDirect] };
    const inner = await listChildSkills(wrapPath, wrap);
    if (inner.length > 0) return { candidates: inner };
  }

  throw new KydogError('skill.invalid', '未找到符合规范的 skill（要求 SKILL.md 在根目录或一层子目录里）');
}

async function tryDir(absDir: string, relPath: string): Promise<SkillCandidate | null> {
  const skillFile = path.join(absDir, 'SKILL.md');
  if (!existsSync(skillFile)) return null;
  return await buildCandidate(skillFile, relPath);
}

async function listChildSkills(absDir: string, relPrefix: string): Promise<SkillCandidate[]> {
  const entries = readdirSync(absDir, { withFileTypes: true });
  const out: SkillCandidate[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const childAbs = path.join(absDir, e.name);
    const skillFile = path.join(childAbs, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    out.push(await buildCandidate(skillFile, rel));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function buildCandidate(skillFile: string, relPath: string): Promise<SkillCandidate> {
  const content = readFileSync(skillFile, 'utf-8');
  const r = await parseSkillFrontmatter(content);
  if (r.ok) {
    return { name: r.name, description: r.description, relPath, alreadyInstalled: null };
  }
  // Show the bad-frontmatter row but disabled. Use the directory basename for display.
  const shown = path.basename(path.dirname(skillFile)) || '(root)';
  return { name: shown, description: '', relPath, alreadyInstalled: null, nameInvalid: r.reason };
}
