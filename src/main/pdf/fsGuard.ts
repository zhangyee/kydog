/** Type guard for Node.js ErrnoException (file system errors). */
export function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}
