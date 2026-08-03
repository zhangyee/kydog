export type AboutDoc = {
  slug: string;
  title: string;
  date: string;
  body: string;
};

export type ParseResult =
  | { ok: true; doc: AboutDoc }
  | { ok: false; reason: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 只解析开头的 `---` 围栏，逐行按第一个 `:` 切 key/value。
 * 不复用 main/harness/frontmatter.ts 与 main/skills/parseSkillFrontmatter.ts ——
 * 那两个都 await import pi SDK，是主进程侧依赖，renderer 用不了。
 */
function splitFrontmatter(raw: string): { fields: Record<string, string>; body: string } | null {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return null;
  // 从 index 3 起找关闭围栏，body 里靠后的 `---` 分隔线不会被误命中。
  const close = text.indexOf('\n---', 3);
  if (close === -1) return null;

  const head = text.slice(4, close + 1);
  const rest = text.slice(close + 4);
  const fields: Record<string, string> = {};
  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    if (!key) continue;
    fields[key] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  const body = (rest.startsWith('\n') ? rest.slice(1) : rest).replace(/^\n+/, '');
  return { fields, body };
}

/** YYYY-MM-DD 且必须是真实存在的日期（挡住 2026-13-01 这类）。 */
function isRealDate(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseAboutDoc(slug: string, raw: string): ParseResult {
  const fm = splitFrontmatter(raw);
  if (!fm) return { ok: false, reason: `${slug}: 缺少 frontmatter 围栏` };

  const title = fm.fields.title ?? '';
  const date = fm.fields.date ?? '';
  if (!title) return { ok: false, reason: `${slug}: frontmatter 缺 title` };
  if (!date) return { ok: false, reason: `${slug}: frontmatter 缺 date` };
  if (!DATE_RE.test(date)) return { ok: false, reason: `${slug}: date 必须是 YYYY-MM-DD，实际是 ${date}` };
  if (!isRealDate(date)) return { ok: false, reason: `${slug}: date 不是真实日期：${date}` };

  return { ok: true, doc: { slug, title, date, body: fm.body } };
}

/** date 降序；同 date 按 slug 降序 tie-break，保证结果确定。返回新数组。 */
export function sortAboutDocs(docs: AboutDoc[]): AboutDoc[] {
  return [...docs].sort((a, b) =>
    a.date === b.date ? b.slug.localeCompare(a.slug) : b.date.localeCompare(a.date),
  );
}

/** setext h1：非空文本行，紧跟一行只有 1~3 个前导空格 + 一个或多个 "=" + 尾随空白。 */
const SETEXT_H1_RE = /^[ \t]{0,3}\S[^\n]*\n[ \t]{0,3}=+[ \t]*$/m;

/**
 * 探测一级标题：ATX（行首 "# "）或 setext（文本行 + 下一行全 "=" 的下划线）。
 * 两种都会被 CommonMark 渲染成 <h1>，和页面自身的标题撞层级。
 * 不认 "-" 下划线（setext h2）和分隔线 "---"（thematic break）—— OFL 原文里两者都有，是正常内容。
 */
export function hasLevelOneHeading(raw: string): boolean {
  return /^# /m.test(raw) || SETEXT_H1_RE.test(raw);
}
