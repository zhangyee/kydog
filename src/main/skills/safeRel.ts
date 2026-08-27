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
