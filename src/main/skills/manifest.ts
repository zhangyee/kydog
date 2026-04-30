import { promises as fs } from 'node:fs';
import { atomicWrite } from '../persist/atomicWrite';

export interface SkillManifestEntry {
  kydogVersion: string;
  files: Record<string, string>; // relPath → sha256
}

export interface SkillManifest {
  kydogVersion: string;
  writtenAt: string;
  builtin: Record<string, SkillManifestEntry>;
}

export function emptyManifest(): SkillManifest {
  return { kydogVersion: '', writtenAt: '', builtin: {} };
}

export async function readManifest(file: string): Promise<SkillManifest> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    const parsed = JSON.parse(raw) as SkillManifest;
    if (typeof parsed !== 'object' || parsed === null || !parsed.builtin) return emptyManifest();
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyManifest();
    throw err;
  }
}

export async function writeManifest(file: string, m: SkillManifest): Promise<void> {
  await atomicWrite(file, JSON.stringify(m, null, 2) + '\n');
}
