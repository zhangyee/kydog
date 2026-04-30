import path from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { app } from 'electron';
import { sha256OfFile } from './sha';

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

/** Walk the skill dir and return { relPath: sha256 } for every regular file. */
export function hashBuiltinSkill(root: string, name: string): Record<string, string> {
  const skillRoot = path.join(root, name);
  const out: Record<string, string> = {};
  walk(skillRoot, '', out);
  return out;
}

function walk(absRoot: string, relPath: string, out: Record<string, string>): void {
  const here = relPath ? path.join(absRoot, relPath) : absRoot;
  for (const entry of readdirSync(here, { withFileTypes: true })) {
    const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
    const childAbs = path.join(absRoot, childRel);
    if (entry.isDirectory()) {
      walk(absRoot, childRel, out);
    } else if (entry.isFile()) {
      out[childRel] = sha256OfFile(childAbs);
    }
  }
}
