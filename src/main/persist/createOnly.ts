import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Fully write our own same-directory inode before atomically linking it into place.
 * link never replaces an existing destination (including a symlink). No rename fallback.
 * Directory access follows ordinary file-tool semantics; this is a no-overwrite policy,
 * not a filesystem sandbox or a guarantee against concurrent parent-directory renames. */
export async function createOnly(
  absolutePath: string,
  content: string,
): Promise<void> {
  const temporary = path.join(
    path.dirname(absolutePath),
    `.kydog-create-${randomUUID()}.tmp`,
  );
  const file = await fs.open(temporary, 'wx');
  try {
    try {
      await file.writeFile(content, 'utf8');
    } finally {
      await file.close();
    }
    await fs.link(temporary, absolutePath);
  } finally {
    await fs.unlink(temporary);
  }
}
