import { promises as fsp } from 'node:fs';
import path from 'node:path';
import * as paths from '../persist/paths';
import { atomicWriteWith0600Async } from '../persist/atomicWrite';
import { validateDisplayName } from './names';
import { THEME_NAMES, READING_FONT_SIZES, type ThemeName, type ReadingFontSize } from '../../shared/types';
import { logger } from '../log';

export type SeedManifest = {
  schemaVersion: 1;
  locale: 'zh' | 'en';
  theme: ThemeName;
  readingFontSize: ReadingFontSize;
  userName: string;
  agentName: string;
};
export type ManifestReadResult =
  | { status: 'none' }
  | { status: 'ok'; manifest: SeedManifest }
  | { status: 'corrupt' };

function manifestPath(dir: string): string { return path.join(dir, path.basename(paths.SEED_MANIFEST_FILE)); }

export async function readManifest(dir: string = paths.ROOT): Promise<ManifestReadResult> {
  let raw: string;
  try { raw = await fsp.readFile(manifestPath(dir), 'utf8'); }
  catch (err) {
    return (err as { code?: string }).code === 'ENOENT' ? { status: 'none' } : { status: 'corrupt' };
  }
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const userName = validateDisplayName(p?.userName);
    const agentName = validateDisplayName(p?.agentName);
    if (p?.schemaVersion === 1
      && (p.locale === 'zh' || p.locale === 'en')
      && (THEME_NAMES as readonly string[]).includes(p.theme as string)
      && (READING_FONT_SIZES as readonly string[]).includes(p.readingFontSize as string)
      && userName && agentName) {
      return { status: 'ok', manifest: { schemaVersion: 1, locale: p.locale, theme: p.theme as ThemeName, readingFontSize: p.readingFontSize as ReadingFontSize, userName, agentName } };
    }
    return { status: 'corrupt' };
  } catch { return { status: 'corrupt' }; }
}

export async function writeManifest(m: SeedManifest, dir: string = paths.ROOT): Promise<void> {
  await atomicWriteWith0600Async(manifestPath(dir), JSON.stringify(m, null, 2));
}

export async function deleteManifest(dir: string = paths.ROOT): Promise<void> {
  try { await fsp.unlink(manifestPath(dir)); }
  catch (err) {
    if ((err as { code?: string }).code !== 'ENOENT') logger.warn('harness.manifest', 'delete failed', { err: String(err) });
  }
}

export async function discardCorruptManifest(dir: string = paths.ROOT): Promise<void> {
  try { await fsp.rename(manifestPath(dir), manifestPath(dir) + '.bad'); logger.warn('harness.manifest', 'corrupt manifest discarded to .bad', {}); }
  catch (err) { logger.warn('harness.manifest', 'discard failed', { err: String(err) }); }
}
