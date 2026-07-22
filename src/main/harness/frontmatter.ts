import { promises as fsp } from 'node:fs';
import { validateDisplayName } from './names';

/** 宽松读取：只认 name 字段；文件缺失/解析失败/name 非法 → null。
 *  不复用 parseSkillFrontmatter（它要求 kebab-case + description，spec §6）。 */
export async function readFrontmatterName(filePath: string): Promise<string | null> {
  let content: string;
  try { content = await fsp.readFile(filePath, 'utf8'); } catch { return null; }
  try {
    const pi = await import('@earendil-works/pi-coding-agent');
    const { frontmatter } = pi.parseFrontmatter<{ name?: unknown }>(content);
    return validateDisplayName(frontmatter?.name);
  } catch { return null; }
}
