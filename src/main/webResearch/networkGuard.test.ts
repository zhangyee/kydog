import { describe, expect, it } from 'vitest';
import { prepareResearchRoute } from './networkGuard';

describe('prepareResearchRoute', () => {
  const publicDns = async () => [{ address: '93.184.216.34', family: 4 as const }];

  it('DIRECT 核验所有 DNS 答案并把本次连接固定到已核验地址', async () => {
    const route = await prepareResearchRoute('https://docs.example/a', {
      resolveProxy: async () => 'DIRECT', resolveDns: publicDns,
    });
    expect(route).toEqual({ ok: true, kind: 'direct', address: '93.184.216.34', family: 4,
      hostname: 'docs.example', assurance: 'dns_pinned' });
  });

  it('公网域名混入私网 DNS 答案时整次请求被拒绝', async () => {
    const good = await prepareResearchRoute('https://docs.example/a', {
      resolveProxy: async () => 'DIRECT', resolveDns: publicDns,
    });
    expect(good.ok).toBe(true);
    const bad = await prepareResearchRoute('https://docs.example/a', {
      resolveProxy: async () => 'DIRECT', resolveDns: async () => [
        { address: '93.184.216.34', family: 4 as const }, { address: '10.0.0.5', family: 4 as const },
      ],
    });
    expect(bad).toEqual({ ok: false, reason: 'dns_private' });
  });

  it('显式内网 URL 在代理解析和请求发送前被拒绝', async () => {
    let proxyCalls = 0;
    const result = await prepareResearchRoute('http://127.0.0.1/private', {
      resolveProxy: async () => { proxyCalls++; return 'PROXY proxy.example:8080'; }, resolveDns: publicDns,
    });
    expect(result).toEqual({ ok: false, reason: 'unsafe_url' });
    expect(proxyCalls).toBe(0);
  });

  it('代理路由承认远端 DNS 不可核验；解析失败不退回 DIRECT', async () => {
    const proxy = await prepareResearchRoute('https://docs.example/a', {
      resolveProxy: async () => 'PROXY proxy.example:8080', resolveDns: publicDns,
    });
    expect(proxy).toEqual({ ok: true, kind: 'http', uri: 'http://proxy.example:8080', assurance: 'proxy_dns_unverified' });
    const failed = await prepareResearchRoute('https://docs.example/a', {
      resolveProxy: async () => { throw new Error('PAC unavailable'); }, resolveDns: publicDns,
    });
    expect(failed).toEqual({ ok: false, reason: 'proxy_unavailable' });
  });

  it('不支持的代理规则不会静默直连', async () => {
    const direct = await prepareResearchRoute('https://docs.example/a', {
      resolveProxy: async () => 'DIRECT', resolveDns: publicDns,
    });
    expect(direct.ok).toBe(true);
    const unavailable = await prepareResearchRoute('https://docs.example/a', {
      resolveProxy: async () => 'QUIC proxy.example:443', resolveDns: publicDns,
    });
    expect(unavailable).toEqual({ ok: false, reason: 'proxy_unavailable' });
    const malformed = await prepareResearchRoute('https://docs.example/a', {
      resolveProxy: async () => 'PROXY [invalid-host', resolveDns: publicDns,
    });
    expect(malformed).toEqual({ ok: false, reason: 'proxy_unavailable' });
  });

  it('显式环境代理优先于系统规则，NO_PROXY 命中时走核验过的 DIRECT', async () => {
    let systemCalls = 0;
    const resolveProxy = async () => { systemCalls++; return 'DIRECT'; };
    const proxyEnvironment = { HTTPS_PROXY: 'http://proxy.example:7890' };
    const proxied = await prepareResearchRoute('https://docs.example/a', {
      resolveProxy, resolveDns: publicDns, proxyEnvironment,
    });
    expect(proxied).toEqual({ ok: true, kind: 'http', uri: 'http://proxy.example:7890/',
      assurance: 'proxy_dns_unverified' });
    expect(systemCalls).toBe(0);
    const bypassed = await prepareResearchRoute('https://docs.example/a', {
      resolveProxy, resolveDns: publicDns, proxyEnvironment: { ...proxyEnvironment, NO_PROXY: 'docs.example' },
    });
    expect(bypassed).toEqual({ ok: true, kind: 'direct', address: '93.184.216.34', family: 4,
      hostname: 'docs.example', assurance: 'dns_pinned' });
    expect(systemCalls).toBe(0);
  });
});
