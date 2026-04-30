import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface DetectResult { found: boolean; searched: string[] }

export interface DetectDeps {
  env: NodeJS.ProcessEnv;
  existsSync: (p: string) => boolean;
  spawnSync: (cmd: string, args: string[], opts?: object) =>
    { status: number | null; stdout: string; stderr: string };
}

const FALLBACK_PATHS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\msys64\\usr\\bin\\bash.exe',
  'C:\\msys32\\usr\\bin\\bash.exe',
];

export function detectBashOnWindowsImpl(d: DetectDeps): DetectResult {
  const searched: string[] = [];
  const tryPaths: string[] = [];
  if (d.env.ProgramFiles) tryPaths.push(`${d.env.ProgramFiles}\\Git\\bin\\bash.exe`);
  const pf86 = d.env['ProgramFiles(x86)'];
  if (pf86) tryPaths.push(`${pf86}\\Git\\bin\\bash.exe`);
  for (const p of FALLBACK_PATHS) {
    if (!tryPaths.includes(p)) tryPaths.push(p);
  }
  for (const p of tryPaths) {
    searched.push(p);
    if (d.existsSync(p)) return { found: true, searched };
  }
  searched.push('PATH (where bash.exe)');
  try {
    const r = d.spawnSync('where', ['bash.exe'], { encoding: 'utf-8', timeout: 5000 });
    if (r.status === 0 && r.stdout && r.stdout.trim()) {
      const first = r.stdout.trim().split(/\r?\n/)[0];
      if (d.existsSync(first)) return { found: true, searched };
    }
  } catch { /* ignore */ }
  return { found: false, searched };
}

export function detectBashOnWindows(): DetectResult {
  return detectBashOnWindowsImpl({
    env: process.env,
    existsSync,
    spawnSync: (cmd, args, opts) => {
      const r = spawnSync(cmd, args, { encoding: 'utf-8', ...opts });
      return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
  });
}
