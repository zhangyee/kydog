/**
 * Node 的 ErrnoException 类型谓词——只判「这个 unknown 身上有没有 code 字段」，好让调用方在
 * catch 里安全地读 `err.code`（ENOENT / EACCES 之类）。
 *
 * 与 `src/main/fs/` 下那些**路径**守卫不是一回事：那边管的是「这个路径能不能碰」（越界、软链
 * 穿透），这里不看路径、也不做任何判定，只是收窄类型。文件名容易让两者混起来，故此说明。
 */
export function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}
