import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { checkUrl } from '../browser/urlGuard';
import { resolveResearchProxyRule, type ProxyResolver } from '../net/systemProxy';

export type DnsAnswer = { address: string; family: 4 | 6 };
export type ResearchRoute =
  | { ok: true; kind: 'direct'; address: string; family: 4 | 6; hostname: string; assurance: 'dns_pinned' }
  | { ok: true; kind: 'http' | 'socks5'; uri: string; assurance: 'proxy_dns_unverified' }
  | { ok: false; reason: 'unsafe_url' | 'dns_private' | 'dns_unavailable' | 'proxy_unavailable' };

export type RouteDeps = {
  resolveProxy: ProxyResolver;
  resolveDns?: (hostname: string) => Promise<DnsAnswer[]>;
  proxyEnvironment?: Record<string, string | undefined>;
};

// Non-public address spaces may terminate at local services. Reject every DNS answer
// in these ranges, not merely the address eventually selected by the connector.
const deny = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) deny.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10],
  ['2001:db8::', 32], ['ff00::', 8],
] as const) deny.addSubnet(address, prefix, 'ipv6');

function isPublicAddress(answer: DnsAnswer): boolean {
  if (isIP(answer.address) !== answer.family) return false;
  if (answer.family === 4) return !deny.check(answer.address, 'ipv4');
  // Node can return IPv4-mapped IPv6 records; the existing URL guard's mapped
  // address check closes that path as well as direct IPv6 literal cases.
  const verdict = checkUrl(`http://[${answer.address}]/`);
  return verdict.ok && !deny.check(answer.address, 'ipv6');
}

/** Returns the same route object later used by the HTTP dispatch. */
export async function prepareResearchRoute(url: string, deps: RouteDeps): Promise<ResearchRoute> {
  const verdict = checkUrl(url);
  if (!verdict.ok) return { ok: false, reason: 'unsafe_url' };
  let rule;
  try { rule = await resolveResearchProxyRule(verdict.url.href, deps.resolveProxy, deps.proxyEnvironment); }
  catch { return { ok: false, reason: 'proxy_unavailable' }; }
  if (rule.kind !== 'direct') return { ok: true, kind: rule.kind, uri: rule.uri,
    assurance: 'proxy_dns_unverified' };
  const hostname = verdict.url.hostname.replace(/^\[(.*)\]$/, '$1');
  let answers: DnsAnswer[];
  try { answers = await (deps.resolveDns ?? (async (host) => lookup(host, { all: true }) as Promise<DnsAnswer[]>))(hostname); }
  catch { return { ok: false, reason: 'dns_unavailable' }; }
  if (!answers.length) return { ok: false, reason: 'dns_unavailable' };
  if (answers.some((answer) => !isPublicAddress(answer))) return { ok: false, reason: 'dns_private' };
  return { ok: true, kind: 'direct', address: answers[0].address, family: answers[0].family,
    hostname, assurance: 'dns_pinned' };
}
