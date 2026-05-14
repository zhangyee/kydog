export type KydogErrorCode =
  | 'settings.invalid'
  | 'settings.write_failed'
  | 'thread.not_found'
  | 'thread.busy'
  | 'thread.has_messages'
  | 'project.not_found'
  | 'project.access_denied'
  | 'agent.provider_error'
  | 'agent.aborted'
  | 'fs.read_failed'
  | 'fs.write_failed'
  | 'not_implemented'
  | 'skill.invalid'
  | 'skill.name_conflict'
  | 'skill.network'
  | 'skill.too_large'
  | 'skill.unsupported_archive'
  | 'skill.extract_failed'
  | 'skill.uninstall_forbidden'
  | 'llm.invalid'
  | 'unknown';

export class KydogError extends Error {
  readonly code: KydogErrorCode;
  readonly cause?: unknown;
  constructor(code: KydogErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'KydogError';
    this.code = code;
    this.cause = cause;
  }
}

export type SerializedError = { code: KydogErrorCode; message: string };

export function serializeError(err: unknown): SerializedError {
  if (err instanceof KydogError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { code: 'unknown', message: err.message };
  return { code: 'unknown', message: String(err) };
}

export interface RpcError extends Error { readonly code: KydogErrorCode }
export function isRpcError(e: unknown): e is RpcError {
  return e instanceof Error && typeof (e as { code?: unknown }).code === 'string';
}
