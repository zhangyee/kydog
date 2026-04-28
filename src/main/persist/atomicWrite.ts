// src/main/persist/atomicWrite.ts
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export async function atomicWrite(target: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${randomUUID()}`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, target);
}
