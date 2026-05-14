import type { ProcessBlock } from './groupBlocks';

export function processWallClock(blocks: ProcessBlock[]): number | null {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const b of blocks) {
    if (typeof b.startedAt === 'number') starts.push(b.startedAt);
    if (typeof b.endedAt === 'number') ends.push(b.endedAt);
  }
  if (!starts.length || !ends.length) return null;
  return Math.max(...ends) - Math.min(...starts);
}
