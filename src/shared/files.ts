import type { SerializedError } from './errors';

/** Shared file-tree eligibility; the main process also checks actual type and project boundary. */
export function isTrashablePath(path: string): boolean {
  return /\.(md|markdown|pdf)$/i.test(path);
}

export type TrashFilesArgs = { projectPath: string; paths: string[] };
export type TrashFilesResult = {
  trashed: string[];
  failed: Array<{ path: string; error: SerializedError }>;
};
