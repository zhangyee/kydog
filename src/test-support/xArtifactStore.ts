import { afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createXResearchArtifactStore } from '../main/x/xResearchArtifacts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true,force:true}); });
export function tempXArtifactStore() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'x-tool-artifacts-'));
  roots.push(root);
  return createXResearchArtifactStore(root);
}
