import { promises as fsp } from 'node:fs';
import { validateDisplayName } from './names';

/** 宽松读取：只认 name 字段；文件缺失/解析失败/name 非法 → null。
 *  不复用 parseSkillFrontmatter（它要求 kebab-case + description，spec §6）。 */
export async function readFrontmatterName(filePath: string): Promise<string | null> {
  let content: string;
  try { content = await fsp.readFile(filePath, 'utf8'); } catch { return null; }
  return (await splitFrontmatter(content)).name;
}

/** 拆出头部的 name 与正文。头部 YAML 坏了 → name 为 null、正文给整份原文（还能看、能改）。 */
export async function splitFrontmatter(content: string): Promise<{ name: string | null; body: string }> {
  try {
    const pi = await import('@earendil-works/pi-coding-agent');
    const { frontmatter, body } = pi.parseFrontmatter<{ name?: unknown }>(content);
    return { name: validateDisplayName(frontmatter?.name), body };
  } catch { return { name: null, body: content }; }
}
