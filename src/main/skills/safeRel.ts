/**
 * skill 树里所有「相对路径」在被用来拼接、写入或删除之前的唯一闸口。
 *
 * 校验一律在动手之前一次性做完，不要边校验边应用 —— 中途抛错会留下半应用的树。
 * 反斜杠一并拒绝：macOS 上它是合法文件名字符，放行会让同一份数据在 Windows 上
 * 被解释成目录分隔符，跨平台行为不一致且无从察觉。
 */
export function assertSafeRel(rel: string, ctx: string): void {
  const bad = (why: string): never => {
    throw new Error(`unsafe relative path in ${ctx}: ${JSON.stringify(rel)} (${why})`);
  };
  if (rel === '') bad('empty');
  if (rel.includes('\0')) bad('contains NUL');
  if (rel.includes('\\')) bad('contains backslash');
  if (rel.startsWith('/')) bad('absolute');
  if (/^[a-zA-Z]:/.test(rel)) bad('drive letter');
  const segs = rel.split('/');
  if (segs.some((s) => s === '..')) bad('parent traversal');
  if (segs.some((s) => s === '')) bad('empty segment');
}

/**
 * skill 目录名的闸口，比 assertSafeRel 更严：名字会被拼成路径去做递归删除
 * （孤儿清理），而它的来源是 manifest —— 一份用户能编辑、也可能损坏的 JSON。
 *
 * 多两道检查，两道都是 assertSafeRel 放行、但对「名字」而言致命的：
 * - `.` 是合法相对路径，可 `path.join(skillsDir, '.')` 等于 skillsDir 本身，
 *   拿去 rm -rf 会把用户自己装的 skill 一起删光；
 * - `a/b` 也是合法相对路径，但 skill 名只能是一个目录名，多段说明这份 manifest
 *   已经不是我们写的了。
 */
export function assertSafeSkillName(name: string, ctx: string): void {
  assertSafeRel(name, ctx);
  const bad = (why: string): never => {
    throw new Error(`unsafe skill name in ${ctx}: ${JSON.stringify(name)} (${why})`);
  };
  if (name === '.') bad('current directory');
  if (name.includes('/')) bad('not a single path segment');
}
