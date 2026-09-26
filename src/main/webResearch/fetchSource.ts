import { Agent, ProxyAgent, Socks5ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { RedirectHop } from '../../shared/webResearch';
import { candidateKey } from './urlIdentity';
import { ResearchBudgetMeter } from './budget';
import { prepareResearchRoute, type ResearchRoute, type RouteDeps } from './networkGuard';

export type FetchInput = { url: string; sourceId?: string; budget: ResearchBudgetMeter; signal: AbortSignal;
  /** The orchestrator has already reserved this dispatch atomically. */
  preReserved?: boolean };
export type FetchResult = {
  requestedUrl: string;
  finalUrl?: string;
  redirectChain: RedirectHop[];
  status: 'readable' | 'unreadable' | 'needs_browser' | 'unsupported_media' |
    'http_error' | 'redirect_error' | 'network_error' | 'cancelled';
  reason?: string;
  statusCode?: number;
  contentType?: string;
  canonicalUrl?: string;
  bytes: Uint8Array;
  receivedBytes: number;
  assurance?: 'dns_pinned' | 'proxy_dns_unverified';
};
type Prepared = Extract<ResearchRoute, { ok: true }>;
type HttpInit = { redirect: 'manual'; signal: AbortSignal; route: Prepared; dispatcher: Dispatcher };
export type FetchDeps = RouteDeps & { httpClient?: (url: string, init: HttpInit) => Promise<Response> };

export function createResearchDispatcher(route: Prepared): Dispatcher {
  if (route.kind !== 'direct') {
    return route.kind === 'http' ? new ProxyAgent({ uri: route.uri }) : new Socks5ProxyAgent(route.uri);
  }
  const { address, family, hostname } = route;
  return new Agent({ connect: {
    lookup: (askedHost, _options, callback) => {
      if (askedHost !== hostname) { callback(new Error('pinned DNS host mismatch'), '', 4); return; }
      if (_options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    },
  } });
}

const defaultClient = (url: string, init: HttpInit): Promise<Response> =>
  undiciFetch(url, { redirect: init.redirect, signal: init.signal, dispatcher: init.dispatcher }) as unknown as Promise<Response>;

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
  }
  return out;
}

function htmlNavigation(bytes: Uint8Array, url: string): { refresh?: string; canonical?: string } {
  const html = new TextDecoder().decode(bytes);
  const head = (/<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? html.slice(0, 8192))
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  let refresh: string | undefined;
  let canonical: string | undefined;
  for (const tag of head.match(/<(?:meta|link)\b[^>]*>/gi) ?? []) {
    const a = attrs(tag);
    if (/^<meta\b/i.test(tag) && a['http-equiv']?.toLowerCase() === 'refresh') {
      const directive = /^\s*\d+(?:\.\d+)?\s*;\s*url\s*=\s*(.+?)\s*$/i.exec(a.content ?? '');
      if (directive) {
        const target = directive[1].replace(/^(?:'|")|(?:'|")$/g, '');
        try { refresh = new URL(target, url).href; } catch { /* malformed directive is not a navigation */ }
      }
    }
    if (/^<link\b/i.test(tag) && a.rel?.toLowerCase().split(/\s+/).includes('canonical') && a.href) {
      try { canonical = new URL(a.href, url).href; } catch { /* ignore malformed metadata */ }
    }
  }
  return { refresh, canonical };
}

async function readBody(response: Response, sourceId: string, budget: ResearchBudgetMeter, signal: AbortSignal):
  Promise<{ ok: true; bytes: Uint8Array; size: number } | { ok: false; reason: string; size: number }> {
  if (!response.body) return { ok: true, bytes: new Uint8Array(), size: 0 };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const signature: number[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) return { ok: false, reason: 'cancelled', size };
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      const reserved = budget.reserveBytes(sourceId, chunk.byteLength);
      if (!reserved.ok) return { ok: false, reason: reserved.reason, size };
      chunks.push(chunk);
      size += chunk.byteLength;
      for (let index = 0; index < chunk.byteLength && signature.length < 5; index++) {
        signature.push(chunk[index]);
      }
      if (signature.length === 5 && signature.every((value, index) =>
        value === [0x25, 0x50, 0x44, 0x46, 0x2d][index])) {
        return { ok: false, reason: 'pdf_not_supported', size };
      }
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return { ok: true, bytes: output, size };
  } catch {
    return { ok: false, reason: signal.aborted ? 'cancelled' : 'request_failed', size };
  } finally {
    try { await reader.cancel(); } catch { /* response may already be closed */ }
    reader.releaseLock();
  }
}

/** Fetch a known URL; all redirects are manual and each hop receives a new guarded route. */
export async function fetchSource(input: FetchInput, deps: FetchDeps): Promise<FetchResult> {
  const requestedUrl = input.url;
  const redirectChain: RedirectHop[] = [];
  const empty = new Uint8Array();
  let assurance: FetchResult['assurance'];
  const result = (status: FetchResult['status'], reason?: string, extra: Partial<FetchResult> = {}): FetchResult =>
    ({ requestedUrl, redirectChain, status, reason, bytes: empty, receivedBytes: 0, ...extra, assurance });
  if (input.signal.aborted) return result('cancelled', 'cancelled');
  const sourceId = input.sourceId ?? requestedUrl;
  if (!input.preReserved) {
    const slot = input.budget.reserveFetch(sourceId);
    if (!slot.ok) return result(slot.reason === 'cancelled' ? 'cancelled' : 'unreadable', slot.reason);
  }
  const seen = new Set<string>();
  let current = requestedUrl;
  let receivedBytes = 0;
  for (;;) {
    if (input.signal.aborted) return result('cancelled', 'cancelled', { finalUrl: current, receivedBytes });
    let key: string;
    try { key = candidateKey(current); }
    catch { return result('network_error', 'unsafe_url', { finalUrl: current, receivedBytes }); }
    if (new URL(current).pathname.toLowerCase().endsWith('.pdf')) {
      return result('unsupported_media', 'pdf_url_excluded', { finalUrl: current, receivedBytes });
    }
    if (seen.has(key)) return result('redirect_error', 'redirect_loop', { finalUrl: current, receivedBytes });
    seen.add(key);
    const route = await prepareResearchRoute(current, deps);
    if (!route.ok) return result('network_error', route.reason, { finalUrl: current, receivedBytes });
    if (route.assurance === 'proxy_dns_unverified') assurance = route.assurance;
    else assurance ??= route.assurance;
    let dispatcher: Dispatcher | undefined;
    try {
      dispatcher = createResearchDispatcher(route);
      const response = await (deps.httpClient ?? defaultClient)(current, {
        redirect: 'manual', signal: input.signal, route, dispatcher,
      });
      const statusCode = response.status;
      if (statusCode >= 300 && statusCode < 400) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) return result('redirect_error', 'missing_location', { finalUrl: current, statusCode, receivedBytes });
        let next: string;
        try { next = new URL(location, current).href; }
        catch { return result('redirect_error', 'invalid_location', { finalUrl: current, statusCode, receivedBytes }); }
        redirectChain.push({ fromUrl: current, toUrl: next, kind: 'http', statusCode });
        if (redirectChain.length > input.budget.limits.maxRedirectsPerSource) {
          return result('redirect_error', 'redirect_limit', { finalUrl: current, statusCode, receivedBytes });
        }
        current = next;
        continue;
      }
      if (statusCode < 200 || statusCode >= 400) {
        await response.body?.cancel();
        return result('http_error', `HTTP ${statusCode}`, { finalUrl: current, statusCode, receivedBytes });
      }
      const contentType = response.headers.get('content-type') ?? undefined;
      const mediaType = contentType?.split(';', 1)[0].trim().toLowerCase();
      if (mediaType === 'application/pdf') {
        await response.body?.cancel();
        return result('unsupported_media', 'pdf_not_supported', { finalUrl: current, statusCode,
          contentType, receivedBytes });
      }
      const body = await readBody(response, sourceId, input.budget, input.signal);
      receivedBytes += body.size;
      if (!body.ok) {
        const status = body.reason === 'cancelled' ? 'cancelled'
          : body.reason === 'pdf_not_supported' ? 'unsupported_media'
          : body.reason === 'request_failed' ? 'network_error' : 'unreadable';
        return result(status, body.reason, { finalUrl: current, statusCode, contentType, receivedBytes });
      }
      const navigation = contentType?.toLowerCase().includes('text/html')
        ? htmlNavigation(body.bytes, current) : {};
      if (navigation.refresh) {
        redirectChain.push({ fromUrl: current, toUrl: navigation.refresh, kind: 'meta_refresh' });
        if (redirectChain.length > input.budget.limits.maxRedirectsPerSource) {
          return result('redirect_error', 'redirect_limit', { finalUrl: current, statusCode, receivedBytes });
        }
        current = navigation.refresh;
        continue;
      }
      return result('readable', undefined, { finalUrl: current, statusCode, contentType,
        canonicalUrl: navigation.canonical, bytes: body.bytes, receivedBytes });
    } catch {
      return result(input.signal.aborted ? 'cancelled' : 'network_error',
        input.signal.aborted ? 'cancelled' : 'request_failed', { finalUrl: current, receivedBytes });
    } finally {
      try { await dispatcher?.close(); } catch { /* preserve the fetch result */ }
    }
  }
}
