const NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type ParseResult =
  | { ok: true; name: string; description: string }
  | { ok: false; reason: string };

type RawFrontmatter = Record<string, unknown> & { name?: unknown; description?: unknown };

const piPromise = import('@earendil-works/pi-coding-agent');

export async function parseSkillFrontmatter(content: string): Promise<ParseResult> {
  const { parseFrontmatter } = await piPromise;
  // parseFrontmatter 对语法错误是**抛**而不是返回空 —— 不接住的话异常会穿过所有调用方：
  // listUnlocked 整个 reject（skill.list RPC 挂掉，连带 tool 列表一起变错误态）、
  // localeSet 的 settled() 在树已经换完之后才抛（回滚不会执行，正好造成它要避免的不一致）、
  // enumerateSkills 的「坏 frontmatter 渲染成禁用行」降级路被架空。
  // 这些下游都已经写好了 ok:false 的处理，缺的只是不让 throw 逃出去。
  //
  // 最容易踩到的一种：description 是无引号 plain scalar 且含半角 `: `，YAML 判成嵌套 mapping。
  // 中文文案用全角 `：` 天然免疫，英文版没有这层保护。
  let frontmatter: RawFrontmatter;
  try {
    ({ frontmatter } = parseFrontmatter<RawFrontmatter>(content));
  } catch (err) {
    return { ok: false, reason: `frontmatter YAML 解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!name) return { ok: false, reason: 'frontmatter 缺 name' };
  if (name.length > 64) return { ok: false, reason: 'name 超过 64 字符' };
  if (!NAME_RE.test(name)) return { ok: false, reason: 'name 含不允许的字符（只允许 a-z 0-9 -，且不以 - 开头/结尾）' };
  if (!description) return { ok: false, reason: 'frontmatter 缺 description 或为空' };
  if (description.length > 1024) return { ok: false, reason: 'description 超过 1024 字符' };
  return { ok: true, name, description };
}
