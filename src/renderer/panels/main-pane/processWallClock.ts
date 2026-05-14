import type { ProcessBlock } from './groupBlocks';

export function processWallClock(blocks: ProcessBlock[]): number | null {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const b of blocks) {
    if (Number.isFinite(b.startedAt)) starts.push(b.startedAt as number);
    if (Number.isFinite(b.endedAt)) ends.push(b.endedAt as number);
  }
  if (!starts.length || !ends.length) return null;
  return Math.max(...ends) - Math.min(...starts);
}
