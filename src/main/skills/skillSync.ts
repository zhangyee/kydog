import { promises as fsp, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { sha256OfFile } from './sha';
import { hashBuiltinSkill, listBuiltinSkills } from './builtinSkills';
import { readManifest, writeManifest, type SkillManifest } from './manifest';

export type SkillAction = 'install' | 'skip' | 'auto-upgrade' | 'conflict';

export interface SkillFileConflict {
  relPath: string;
  shippedSha: string;
  diskSha: string;
  recordedSha: string | null;
}

export interface SkillClassification {
  action: SkillAction;
  /** files we should write unconditionally (missing or auto-upgrade) */
  toWrite: string[];
  /** files where user changed and ship also changed; user must decide */
  conflicts: SkillFileConflict[];
}

export interface ClassifyInputs {
  shippedFiles: Record<string, string>;       // relPath → sha256
  recordedFiles: Record<string, string>;      // last manifest snapshot
  diskHashes: Record<string, string>;         // current ~/.kydog/skills/<name>/ contents (only files we know how to hash)
  diskExists: boolean;
}

export function classifySkill(i: ClassifyInputs): SkillClassification {
  if (!i.diskExists) {
    return { action: 'install', toWrite: Object.keys(i.shippedFiles).sort(), conflicts: [] };
  }
  const toWrite: string[] = [];
  const conflicts: SkillFileConflict[] = [];
  for (const [rel, shippedSha] of Object.entries(i.shippedFiles)) {
    const diskSha = i.diskHashes[rel] ?? null;
    const recordedSha = i.recordedFiles[rel] ?? null;
    if (diskSha === null) { toWrite.push(rel); continue; }       // missing → write
    if (diskSha === shippedSha) continue;                        // already correct
    if (recordedSha !== null && diskSha === recordedSha) {
      // user untouched, shipped updated
      toWrite.push(rel); continue;
    }
    // user changed AND shipped also changed
    conflicts.push({ relPath: rel, shippedSha, diskSha, recordedSha });
  }
  let action: SkillAction;
  if (conflicts.length > 0) action = 'conflict';
  else if (toWrite.length === 0) action = 'skip';
  else action = 'auto-upgrade';
  return { action, toWrite: toWrite.sort(), conflicts: conflicts.sort((a, b) => a.relPath.localeCompare(b.relPath)) };
}

// ----------------------------------------------------------------

export interface PendingSkillConflict {
  skill: string;
  conflicts: SkillFileConflict[];
}

export interface SyncResult {
  installedOrUpgraded: { skill: string; files: string[]; action: 'install' | 'auto-upgrade' }[];
  pendingConflicts: PendingSkillConflict[];
  /** Names of user-only skill dirs found in ~/.kydog/skills/ — left untouched. */
  userSkills: string[];
  /** Latest manifest after auto-applies. */
  manifest: SkillManifest;
}

export interface SyncInputs {
  builtinRoot: string;
  kydogSkillsDir: string;       // ~/.kydog/skills
  manifestPath: string;          // ~/.kydog/skills/.manifest.json
  kydogVersion: string;
}

export async function runSkillSync(i: SyncInputs): Promise<SyncResult> {
  await fsp.mkdir(i.kydogSkillsDir, { recursive: true });
  const builtinNames = listBuiltinSkills(i.builtinRoot);
  const manifestStart = await readManifest(i.manifestPath);
  const manifest: SkillManifest = {
    kydogVersion: i.kydogVersion,
    writtenAt: new Date().toISOString(),
    builtin: { ...manifestStart.builtin },
  };

  const installedOrUpgraded: SyncResult['installedOrUpgraded'] = [];
  const pendingConflicts: PendingSkillConflict[] = [];

  for (const name of builtinNames) {
    const shipped = hashBuiltinSkill(i.builtinRoot, name);
    const recorded = manifestStart.builtin[name]?.files ?? {};
    const diskDir = path.join(i.kydogSkillsDir, name);
    const diskExists = existsSync(diskDir);
    const diskHashes: Record<string, string> = {};
    if (diskExists) {
      for (const rel of Object.keys(shipped)) {
        const abs = path.join(diskDir, rel);
        if (existsSync(abs)) diskHashes[rel] = sha256OfFile(abs);
      }
    }
    const cls = classifySkill({ shippedFiles: shipped, recordedFiles: recorded, diskHashes, diskExists });
    if (cls.action === 'skip') continue;
    if (cls.action === 'conflict') {
      // Auto-write the non-conflicting toWrite files now (missing-only); leave conflicts pending.
      if (cls.toWrite.length > 0) {
        await writeFiles(i.builtinRoot, name, cls.toWrite, i.kydogSkillsDir);
      }
      pendingConflicts.push({ skill: name, conflicts: cls.conflicts });
      // Record the auto-written files into the manifest so the next sync uses the right
      // baseline for them. Leave the conflicting files' recordedSha untouched so the same
      // conflict reappears on every boot until the user resolves it via the UI.
      if (cls.toWrite.length > 0) {
        const prev = manifest.builtin[name];
        const newFiles: Record<string, string> = { ...(prev?.files ?? recorded) };
        for (const rel of cls.toWrite) newFiles[rel] = shipped[rel];
        manifest.builtin[name] = { kydogVersion: i.kydogVersion, files: newFiles };
      }
      continue;
    }
    // install or auto-upgrade
    await writeFiles(i.builtinRoot, name, cls.toWrite, i.kydogSkillsDir);
    manifest.builtin[name] = {
      kydogVersion: i.kydogVersion,
      files: shipped,  // all shipped files now match disk
    };
    installedOrUpgraded.push({ skill: name, files: cls.toWrite, action: cls.action });
  }

  await writeManifest(i.manifestPath, manifest);

  // Enumerate user-only skill dirs (not in builtin list)
  const userSkills = existsSync(i.kydogSkillsDir)
    ? readdirSync(i.kydogSkillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !builtinNames.includes(e.name))
        .map((e) => e.name)
    : [];

  return { installedOrUpgraded, pendingConflicts, userSkills, manifest };
}

async function writeFiles(builtinRoot: string, name: string, rels: string[], kydogSkillsDir: string): Promise<void> {
  for (const rel of rels) {
    const src = path.join(builtinRoot, name, rel);
    const dest = path.join(kydogSkillsDir, name, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    await fsp.copyFile(src, dest);
  }
}

// ----------------------------------------------------------------
// Apply user choices from the conflict modal.

export interface ApplyOverridesInputs {
  builtinRoot: string;
  kydogSkillsDir: string;
  manifestPath: string;
  kydogVersion: string;
  operations: { skill: string; files: string[] }[];   // files user chose to overwrite
}

export async function applyOverrides(i: ApplyOverridesInputs): Promise<SkillManifest> {
  const m = await readManifest(i.manifestPath);
  for (const op of i.operations) {
    await writeFiles(i.builtinRoot, op.skill, op.files, i.kydogSkillsDir);
    // After writing chosen files, fold them into manifest entry.
    const shipped = hashBuiltinSkill(i.builtinRoot, op.skill);
    const entry = m.builtin[op.skill] ?? { kydogVersion: i.kydogVersion, files: {} };
    for (const rel of op.files) entry.files[rel] = shipped[rel];
    entry.kydogVersion = i.kydogVersion;
    m.builtin[op.skill] = entry;
  }
  m.kydogVersion = i.kydogVersion;
  m.writtenAt = new Date().toISOString();
  await writeManifest(i.manifestPath, m);
  return m;
}
