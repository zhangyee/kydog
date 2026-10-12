import type { XFactRelation, XLocationRelation, XSafeLocation } from './xResearchTypes';

function parseUrl(raw: string): URL | null {
  try { return new URL(raw); } catch { return null; }
}
function isXOrigin(url: URL): boolean {
  return url.protocol === 'https:' && !url.port && (url.hostname === 'x.com' || url.hostname === 'twitter.com');
}
function postId(url: URL): string | null {
  if (!isXOrigin(url)) return null;
  return /^(?:\/[A-Za-z0-9_]+\/status|\/i\/web\/status)\/([0-9]+)(?:\/history|\/(?:photo|video)\/[0-9]+)?\/?$/.exec(url.pathname)?.[1] ?? null;
}
function singleParam(url: URL | null, name: string): string | null {
  const values = url?.searchParams.getAll(name);
  return values?.length === 1 ? values[0] : null;
}
function relation(a: string | null | undefined, b: string | null | undefined): XFactRelation {
  if (a == null || b == null) return 'unknown';
  return a === b ? 'same' : 'different';
}
/** Compare original coordinates before redaction. Never compare safe representations. */
export function compareXLocation(requestedUrl: string, actualUrl: string): XLocationRelation {
  const requested = parseUrl(requestedUrl), actual = parseUrl(actualUrl);
  return {
    origin: relation(requested?.origin, actual?.origin),
    path: relation(requested?.pathname, actual?.pathname),
    postId: relation(requested && postId(requested), actual && postId(actual)),
    query: relation(singleParam(requested, 'q'), singleParam(actual, 'q')),
    product: relation(singleParam(requested, 'f'), singleParam(actual, 'f')),
    fragment: relation(requested?.hash || null, actual?.hash || null),
  };
}
/** The allowlist excludes login/challenge routes, arbitrary query values and fragments. */
export function toSafeXLocation(raw: string): XSafeLocation {
  const url = parseUrl(raw);
  const empty: XSafeLocation = { origin: null, path: null, q: null, f: null, fragment: null, redacted: true };
  if (!url || !isXOrigin(url)) return empty;
  const publicPath = postId(url) !== null || url.pathname === '/search';
  const search = url.pathname === '/search';
  const q = search ? singleParam(url, 'q') : null;
  const f = search ? singleParam(url, 'f') : null;
  const unsafeParams = [...url.searchParams.keys()].some((key) => !search || !['q', 'f'].includes(key)) || (search && (url.searchParams.getAll('q').length > 1 || url.searchParams.getAll('f').length > 1));
  return { origin: url.origin, path: publicPath ? url.pathname : null, q, f, fragment: null, redacted: !publicPath || !!url.username || !!url.password || unsafeParams || !!url.hash };
}
/** Explicit targets must already name a public X post; unresolved IDs stay unresolved. */
export function isXPostUrl(raw: string): boolean {
  const url = parseUrl(raw);
  return !!url && !url.username && !url.password && postId(url) !== null;
}
