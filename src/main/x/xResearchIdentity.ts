import type {
  XFactRelation,
  XLocationRelation,
  XSafeLocation,
} from './xResearchTypes';

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}
function isXOrigin(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    !url.port &&
    (url.hostname === 'x.com' || url.hostname === 'twitter.com')
  );
}
// Public source protocol bounds, distinct from generic DOM string resource limits.
// https://help.x.com/en/managing-your-account/x-username-rules
// https://docs.x.com/fundamentals/x-ids
export const X_MAX_HANDLE_UNITS = 15;
export const X_MAX_POST_ID_UNITS = 20;
export const X_MAX_RAW_URL_UNITS = 8192;
export const X_MAX_SOURCE_URL_UNITS =
  'https://twitter.com/'.length +
  X_MAX_HANDLE_UNITS +
  '/status/'.length +
  X_MAX_POST_ID_UNITS +
  '/history/'.length;
export function isXHandle(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(value);
}
export function isXPostId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9]{1,20}$/.test(value) &&
    BigInt(value) <= 18446744073709551615n
  );
}
/** Parse coordinates without rewriting the literal input or deriving anything from an ID. */
export function parseXPostCoordinates(
  raw: string,
  options: { allowMedia?: boolean; allowQuery?: boolean } = {},
): { id: string; handle: string | null; origin: string; url: string } | null {
  if (raw.length > X_MAX_RAW_URL_UNITS) return null;
  const url = parseUrl(raw);
  if (
    !url ||
    !isXOrigin(url) ||
    url.username ||
    url.password ||
    (!options.allowQuery && (url.search || url.hash))
  )
    return null;
  const match =
    /^\/(?:([A-Za-z0-9_]+)\/status|i\/web\/status)\/([0-9]+)(?:(\/history)|\/(photo|video)\/[0-9]+)?\/?$/.exec(
      url.pathname,
    );
  if (
    !match ||
    (match[1] !== undefined && !isXHandle(match[1])) ||
    !isXPostId(match[2]) ||
    (match[4] && !options.allowMedia)
  )
    return null;
  return {
    id: match[2],
    handle: match[1] ?? null,
    origin: url.origin,
    url: raw,
  };
}
/** An actual source is bounded by its permitted origin/path, never by generic DOM prose. */
export function parseXSourcePost(raw: string | null, coordinatesOnly = false) {
  if (!raw || (!coordinatesOnly && raw.length > X_MAX_SOURCE_URL_UNITS))
    return null;
  return parseXPostCoordinates(raw, { allowQuery: coordinatesOnly });
}
function postId(url: URL): string | null {
  return (
    parseXPostCoordinates(url.href, { allowMedia: true, allowQuery: true })
      ?.id ?? null
  );
}
function singleParam(url: URL | null, name: string): string | null {
  const values = url?.searchParams.getAll(name);
  return values?.length === 1 ? values[0] : null;
}
function relation(
  a: string | null | undefined,
  b: string | null | undefined,
): XFactRelation {
  if (a == null || b == null) return 'unknown';
  return a === b ? 'same' : 'different';
}
/** Compare original coordinates before redaction. Never compare safe representations. */
export function compareXLocation(
  requestedUrl: string,
  actualUrl: string,
): XLocationRelation {
  const requested = parseUrl(requestedUrl),
    actual = parseUrl(actualUrl);
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
  const empty: XSafeLocation = {
    origin: null,
    path: null,
    q: null,
    f: null,
    fragment: null,
    redacted: true,
  };
  if (!url || !isXOrigin(url)) return empty;
  const publicPath = postId(url) !== null || url.pathname === '/search';
  const search = url.pathname === '/search';
  const q = search ? singleParam(url, 'q') : null;
  const f = search ? singleParam(url, 'f') : null;
  const unsafeParams =
    [...url.searchParams.keys()].some(
      (key) => !search || !['q', 'f'].includes(key),
    ) ||
    (search &&
      (url.searchParams.getAll('q').length > 1 ||
        url.searchParams.getAll('f').length > 1));
  return {
    origin: url.origin,
    path: publicPath ? url.pathname : null,
    q,
    f,
    fragment: null,
    redacted:
      !publicPath ||
      !!url.username ||
      !!url.password ||
      unsafeParams ||
      !!url.hash,
  };
}
/** Explicit targets must already name a public X post; unresolved IDs stay unresolved. */
export function isXPostUrl(raw: string): boolean {
  return (
    parseXPostCoordinates(raw, { allowMedia: true, allowQuery: true }) !== null
  );
}

export type XArticleIdentityVerdict =
  | { proven: true; stage: 'body'; reason: null }
  | { proven: false; stage: 'entry' | 'navigation' | 'body'; reason: string };
/** The collector's private entry/action proof is prerequisite, never reconstructed here. */
export function proveArticleIdentity(
  entry: import('./xResearchTypes').XArticleEntry,
  page: import('./xPageSource').XPageObservation,
  navigation: import('../../shared/types').NavigationObservation | null,
): XArticleIdentityVerdict {
  if (!entry.parentPostId || !entry.sourceUrl)
    return {
      proven: false,
      stage: 'entry',
      reason: 'article_entry_identity_unproven',
    };
  const destination =
    navigation &&
    (navigation.outcome.kind === 'ok' ||
      navigation.outcome.kind === 'ok_same_document')
      ? navigation.outcome.finalUrl
      : null;
  const actual = destination ? parseUrl(destination) : null;
  if (
    !actual ||
    !isXOrigin(actual) ||
    actual.username ||
    actual.password ||
    actual.search ||
    actual.hash ||
    !postId(actual) ||
    (entry.targetUrl !== null && entry.targetUrl !== destination) ||
    page.location.current.origin !== actual.origin ||
    page.location.current.path !== actual.pathname
  )
    return {
      proven: false,
      stage: 'navigation',
      reason: 'article_navigation_identity_unproven',
    };
  const body = page.article?.body;
  const handle = /^\/([A-Za-z0-9_]+)\/status\//.exec(actual.pathname)?.[1];
  if (
    page.stage !== 'article' ||
    !page.identityProven ||
    !body ||
    body.sourceUrl !== destination ||
    body.postId !== postId(actual) ||
    !handle ||
    body.author?.handle !== handle ||
    (entry.author?.handle != null &&
      entry.author.handle !== body.author.handle) ||
    !body.text
  )
    return {
      proven: false,
      stage: 'body',
      reason: 'article_body_identity_unproven',
    };
  return { proven: true, stage: 'body', reason: null };
}
/** Explicit end evidence closes only the exact observed root/branch/sort scope. */
export function applyReplyEndEvidence(
  scope: import('./xResearchTypes').XReplyScope,
  end: import('./xResearchTypes').XReplyEndEvidence | null,
): import('./xResearchTypes').XReplyScope {
  const matches =
    !!end &&
    end.rootPostId === scope.rootPostId &&
    (end.branch === null
      ? scope.branch === null
      : scope.branch !== null &&
        end.branch.postId === scope.branch.postId &&
        end.branch.sourceUrl === scope.branch.sourceUrl) &&
    (end.sort === null
      ? scope.sort === null
      : scope.sort !== null &&
        end.sort.label === scope.sort.label &&
        end.sort.value === scope.sort.value);
  return matches
    ? {
        ...scope,
        completeness: 'ui_scope_end_observed',
        endEvidence: end!,
        stopReason: 'explicit_ui_end',
      }
    : { ...scope, completeness: 'unknown', endEvidence: null };
}
