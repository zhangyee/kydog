import { createHash } from 'node:crypto';
import path from 'node:path';

export function cwdHash(absolutePath: string): string {
  const normalized = path.resolve(absolutePath);
  // 8-hex (32-bit) prefix: ~3e-7 collision probability for ~50 projects per user.
  // Widen to 16 if collision risk ever materialises (filesystem path budget is fine).
  return createHash('sha256').update(normalized).digest('hex').slice(0, 8);
}
