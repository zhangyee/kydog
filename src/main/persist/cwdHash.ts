import { createHash } from 'node:crypto';
import path from 'node:path';

export function cwdHash(absolutePath: string): string {
  const normalized = path.resolve(absolutePath);
  return createHash('sha256').update(normalized).digest('hex').slice(0, 8);
}
