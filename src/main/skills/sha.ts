import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function sha256OfBuffer(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

export function sha256OfFile(filePath: string): string {
  return sha256OfBuffer(readFileSync(filePath));
}
