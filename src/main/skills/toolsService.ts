import { readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { ToolEntry } from '../../shared/types';
import { binDir as defaultBinDir } from '../bin/binPath';

export interface ToolsServiceDeps {
  binDir: () => string;
  ttlMs: number;
  spawnTimeoutMs?: number;
}

interface CacheEntry {
  entries: ToolEntry[];
  at: number;
}

export class ToolsService {
  private cache: CacheEntry | null = null;
  constructor(private readonly deps: ToolsServiceDeps) {}

  async list(opts?: { force?: boolean }): Promise<ToolEntry[]> {
    if (!opts?.force && this.cache && Date.now() - this.cache.at < this.deps.ttlMs) {
      return this.cache.entries;
    }
    const dir = this.deps.binDir();
    const candidates = listExecutables(dir);
    const entries: ToolEntry[] = [];
    for (const name of candidates) {
      const fullPath = path.join(dir, name);
      const version = await detectVersion(fullPath, this.deps.spawnTimeoutMs ?? 1500);
      entries.push({ name: stripExeSuffix(name), version, path: fullPath });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    this.cache = { entries, at: Date.now() };
    return entries;
  }
}

function listExecutables(dir: string): string[] {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  if (process.platform === 'win32') {
    return names.filter((n) => n.toLowerCase().endsWith('.exe'));
  }
  return names.filter((n) => {
    try {
      const s = statSync(path.join(dir, n));
      return s.isFile() && (s.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  });
}

function stripExeSuffix(name: string): string {
  return process.platform === 'win32' && name.toLowerCase().endsWith('.exe')
    ? name.slice(0, -4)
    : name;
}

async function detectVersion(bin: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const proc = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (b) => {
      out += b.toString();
    });
    proc.stderr.on('data', (b) => {
      out += b.toString();
    });
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      resolve(null);
    }, timeoutMs);
    proc.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(null);
    });
    proc.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const firstLine = out.split('\n').find((l) => l.trim().length > 0)?.trim() ?? null;
      resolve(firstLine);
    });
  });
}

export const toolsService = new ToolsService({ binDir: defaultBinDir, ttlMs: 5 * 60_000 });
