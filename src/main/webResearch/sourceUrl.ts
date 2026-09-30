export type ResolvedSourceUrls = { contentUrl: string; reportUrl: string };

/** Map only the exact public GitHub Blob URL shape; keep every encoded path byte untouched. */
export function resolveSourceUrls(requestedUrl: string): ResolvedSourceUrls {
  let parsed: URL;
  try { parsed = new URL(requestedUrl); }
  catch { return { contentUrl: requestedUrl, reportUrl: requestedUrl }; }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com' || parsed.port ||
    parsed.username || parsed.password) return { contentUrl: requestedUrl, reportUrl: requestedUrl };
  const segments = parsed.pathname.split('/');
  if (segments.length < 7 || segments[0] !== '' || segments[3] !== 'blob' ||
    segments.slice(1).some((segment) => !segment)) {
    return { contentUrl: requestedUrl, reportUrl: requestedUrl };
  }
  const [owner, repo, , ref, ...filePath] = segments.slice(1);
  if (!owner || !repo || !ref || !filePath.length) return { contentUrl: requestedUrl, reportUrl: requestedUrl };
  return { contentUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath.join('/')}`,
    reportUrl: requestedUrl };
}
