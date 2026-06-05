const NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type ParseResult =
  | { ok: true; name: string; description: string }
  | { ok: false; reason: string };

type RawFrontmatter = Record<string, unknown> & { name?: unknown; description?: unknown };

const piPromise = import('@earendil-works/pi-coding-agent');

export async function parseSkillFrontmatter(content: string): Promise<ParseResult> {
  const { parseFrontmatter } = await piPromise;
  const { frontmatter } = parseFrontmatter<RawFrontmatter>(content);
  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!name) return { ok: false, reason: 'frontmatter 缺 name' };
  if (name.length > 64) return { ok: false, reason: 'name 超过 64 字符' };
  if (!NAME_RE.test(name)) return { ok: false, reason: 'name 含不允许的字符（只允许 a-z 0-9 -，且不以 - 开头/结尾）' };
  if (!description) return { ok: false, reason: 'frontmatter 缺 description 或为空' };
  if (description.length > 1024) return { ok: false, reason: 'description 超过 1024 字符' };
  return { ok: true, name, description };
}
