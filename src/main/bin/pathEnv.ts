import path from 'node:path';

export function computePathPrefix(
  binDir: string,
  existing: string | undefined,
  sep: string,
): string {
  if (!existing) return binDir;
  const parts = existing.split(sep);
  if (parts[0] === binDir) return existing;
  return `${binDir}${sep}${existing}`;
}

export function prependBinDirToPath(binDir: string): void {
  const sep = path.delimiter;
  process.env.PATH = computePathPrefix(binDir, process.env.PATH, sep);
}
