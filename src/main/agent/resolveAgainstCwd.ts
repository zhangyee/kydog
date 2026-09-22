// src/main/agent/resolveAgainstCwd.ts
import path from 'node:path';

/**
 * 把 agent 传来的「相对项目目录的路径」补成绝对路径，供 read_docx / read_pdf_figure
 * 这类工具在调用现有的绝对路径校验器（readDocxTool.validatePath / pdfRaster.validateRenderArgs）
 * 之前使用。见 docs/superpowers/reviews/2026-09-21-composer-attachments-comments/relpath-brief.md。
 *
 * 故意**只做字符串拼接**，绝不用 path.join / path.resolve / path.normalize：那几个函数
 * 会把 `..` 段吃掉——`path.join('/proj', '../etc/x.pdf')` 是 `/etc/x.pdf`，越界的路径
 * 拼完就再也检测不出来了。这里拼完原样交给原来的校验器，`..` 段、NUL、后缀检查仍然
 * 由它们负责，这个函数本身不做任何路径语义判断。
 *
 * 非字符串、空串、已经是绝对路径、或没给 cwd 时原样返回，交给下游校验器按老规矩处理
 * （分别报「需要一个文件路径」「路径必须是绝对路径」等）。
 */
export function resolveAgainstCwd(raw: unknown, cwd?: string): unknown {
  if (typeof raw !== 'string' || raw.length === 0) return raw;
  if (path.isAbsolute(raw)) return raw;
  if (!cwd) return raw;
  return `${cwd}${path.sep}${raw}`;
}
