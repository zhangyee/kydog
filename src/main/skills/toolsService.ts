import { existsSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { dialog } from 'electron';
import type { ExternalBinEntry, ToolEntry } from '../../shared/types';
import { binDir as defaultBinDir } from '../bin/binPath';
import { settingsService as defaultSettingsService } from '../settings/settingsService';
import { prependBinDirToPath } from '../bin/pathEnv';
import { KydogError } from '../../shared/errors';

export interface ToolsServiceDeps {
  binDir: () => string;
  ttlMs: number;
  spawnTimeoutMs?: number;
  externalBins?: () => Promise<ExternalBinEntry[]>;
  setExternalBins?: (next: ExternalBinEntry[]) => Promise<void>;
  pickFile?: () => Promise<string | null>;
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
    const builtinNames = listExecutables(dir);
    const entries: ToolEntry[] = [];
    for (const name of builtinNames) {
      const fullPath = path.join(dir, name);
      const version = await detectVersion(fullPath, this.deps.spawnTimeoutMs ?? 1500);
      entries.push({ name: stripExeSuffix(name), version, path: fullPath, origin: 'builtin' });
    }
    const externals = this.deps.externalBins ? await this.deps.externalBins() : [];
    for (const ext of externals) {
      let version: string | null = null;
      if (existsSync(ext.path)) {
        version = await detectVersion(ext.path, this.deps.spawnTimeoutMs ?? 1500);
      }
      entries.push({ name: ext.name, version, path: ext.path, origin: 'external' });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    this.cache = { entries, at: Date.now() };
    return entries;
  }

  async addExternal(): Promise<ToolEntry[]> {
    const pick = this.deps.pickFile ?? defaultPickFile;
    const filePath = await pick();
    if (!filePath) return this.list({ force: true });

    let stat;
    try { stat = statSync(filePath); }
    catch { throw new KydogError('skill.invalid', `无法读取所选文件：${filePath}`); }
    if (!stat.isFile()) {
      throw new KydogError('skill.invalid', '所选不是常规文件');
    }
    if (process.platform === 'win32') {
      if (!filePath.toLowerCase().endsWith('.exe')) {
        throw new KydogError('skill.invalid', '所选文件不是可执行文件');
      }
    } else {
      if ((stat.mode & 0o111) === 0) {
        throw new KydogError('skill.invalid', '所选文件不是可执行文件');
      }
    }

    const baseName = path.basename(filePath);
    const name = process.platform === 'win32' && baseName.toLowerCase().endsWith('.exe')
      ? baseName.slice(0, -4)
      : baseName;

    const externals = this.deps.externalBins ? await this.deps.externalBins() : [];
    if (externals.some((b) => b.path === filePath)) {
      throw new KydogError('skill.name_conflict', '该路径已添加');
    }
    // Name collision: against builtins (from binDir) AND existing externals
    const builtinNamesRaw = listExecutables(this.deps.binDir());
    const builtinNames = new Set(builtinNamesRaw.map(stripExeSuffix));
    if (builtinNames.has(name) || externals.some((b) => b.name === name)) {
      throw new KydogError('skill.name_conflict', `名为 ${name} 的工具已存在`);
    }

    const newEntry: ExternalBinEntry = {
      name,
      path: filePath,
      addedAt: new Date().toISOString(),
    };
    if (!this.deps.setExternalBins) {
      throw new KydogError('skill.invalid', '外部工具持久化未配置');
    }
    await this.deps.setExternalBins([...externals, newEntry]);
    prependBinDirToPath(path.dirname(filePath));

    return this.list({ force: true });
  }

  async removeExternal(args: { path: string }): Promise<ToolEntry[]> {
    const externals = this.deps.externalBins ? await this.deps.externalBins() : [];
    const found = externals.find((b) => b.path === args.path);
    if (!found) {
      throw new KydogError('skill.invalid', '该工具不存在');
    }
    const next = externals.filter((b) => b.path !== args.path);
    if (!this.deps.setExternalBins) {
      throw new KydogError('skill.invalid', '外部工具持久化未配置');
    }
    await this.deps.setExternalBins(next);
    // V1 limitation: PATH may still contain the dir for this session;
    // a stale entry simply won't resolve. Restart for full cleanup.
    return this.list({ force: true });
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
    let proc;
    try {
      proc = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null);
      return;
    }
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

async function defaultPickFile(): Promise<string | null> {
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    title: '选择 CLI 二进制',
    defaultPath: os.homedir(),
  });
  if (r.canceled || r.filePaths.length === 0) return null;
  return r.filePaths[0];
}

export const toolsService = new ToolsService({
  binDir: defaultBinDir,
  ttlMs: 5 * 60_000,
  externalBins: async () => (await defaultSettingsService.get()).tools.externalBins,
  setExternalBins: async (next) => {
    await defaultSettingsService.update({ tools: { externalBins: next } });
  },
});
