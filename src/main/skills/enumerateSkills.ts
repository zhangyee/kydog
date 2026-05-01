import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { KydogError } from '../../shared/errors';
import type { SkillCandidate } from '../../shared/types';
import { parseSkillFrontmatter } from './parseSkillFrontmatter';

export type EnumerateResult = { candidates: SkillCandidate[] };

export function enumerateSkills(baseDir: string): EnumerateResult {
  const direct = tryDir(baseDir, '');
  if (direct) return { candidates: [direct] };

  const oneLevel = listChildSkills(baseDir, '');
  if (oneLevel.length > 0) return { candidates: oneLevel };

  // Try unwrap one level
  const subdirs = readdirSync(baseDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith('.'));
  if (subdirs.length === 1) {
    const wrap = subdirs[0].name;
    const wrapPath = path.join(baseDir, wrap);
    const wrapDirect = tryDir(wrapPath, wrap);
    if (wrapDirect) return { candidates: [wrapDirect] };
    const inner = listChildSkills(wrapPath, wrap);
    if (inner.length > 0) return { candidates: inner };
  }

  throw new KydogError('skill.invalid', '未找到符合规范的 skill（要求 SKILL.md 在根目录或一层子目录里）');
}

function tryDir(absDir: string, relPath: string): SkillCandidate | null {
  const skillFile = path.join(absDir, 'SKILL.md');
  if (!existsSync(skillFile)) return null;
  return buildCandidate(skillFile, relPath);
}

function listChildSkills(absDir: string, relPrefix: string): SkillCandidate[] {
  const entries = readdirSync(absDir, { withFileTypes: true });
  const out: SkillCandidate[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const childAbs = path.join(absDir, e.name);
    const skillFile = path.join(childAbs, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    out.push(buildCandidate(skillFile, rel));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function buildCandidate(skillFile: string, relPath: string): SkillCandidate {
  const content = readFileSync(skillFile, 'utf-8');
  const r = parseSkillFrontmatter(content);
  if (r.ok) {
    return { name: r.name, description: r.description, relPath, alreadyInstalled: null };
  }
  // Show the bad-frontmatter row but disabled. Use the directory basename for display.
  const shown = path.basename(path.dirname(skillFile)) || '(root)';
  return { name: shown, description: '', relPath, alreadyInstalled: null, nameInvalid: r.reason };
}
