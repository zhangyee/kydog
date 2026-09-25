import type { Discovery } from '../../shared/webResearch';

/** Preserve query bytes as represented by WHATWG URL; only remove fragments. */
export function candidateKey(raw: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported URL');
  url.hash = '';
  return url.href;
}

/** Merge observation records without treating independent search hits as votes or duplicates. */
export function mergeDiscoveries(existing: readonly Discovery[], incoming: readonly Discovery[]): Discovery[] {
  return [...existing, ...incoming];
}
