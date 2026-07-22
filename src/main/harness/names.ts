export const DEFAULT_USER_NAME = 'You';
export const DEFAULT_AGENT_NAME = 'KyDog';

/** 称呼校验：trim 后非空、≤64 字符、无换行与控制字符；不满足返回 null（spec §6/§9.1）。 */
export function validateDisplayName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.length > 64) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(name)) return null;
  return name;
}
