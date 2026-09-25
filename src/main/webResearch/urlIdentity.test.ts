import { describe, expect, it } from 'vitest';
import { candidateKey, mergeDiscoveries } from './urlIdentity';
import type { Discovery } from '../../shared/webResearch';

describe('candidateKey', () => {
  it('只移除 fragment 与默认端口，保留会改变正文的 query', () => {
    const v1 = candidateKey('https://DOCS.example:443/a?v=1#part');
    expect(v1).toBe('https://docs.example/a?v=1');
    const v2 = candidateKey('https://docs.example/a?v=2');
    expect(v2).toBe('https://docs.example/a?v=2');
    expect(v2).not.toBe(v1);
  });

  it('拒绝不能作为抓取目标的 URL', () => {
    expect(candidateKey('https://docs.example/x')).toBe('https://docs.example/x');
    expect(() => candidateKey('file:///etc/passwd')).toThrow();
    expect(() => candidateKey('javascript:alert(1)')).toThrow();
  });
});

describe('mergeDiscoveries', () => {
  it('同一目标跨引擎命中仍保存两份实际发现背景', () => {
    const base = {
      angleId: 'upgrade', query: 'TypeScript 6.0', resultUrl: 'https://docs.example/v6',
      searchPageUrl: 'https://search.example/?q=typescript',
    } as const;
    const fromBing: Discovery = { ...base, attemptId: 'a-bing', engineId: 'bing', title: 'Bing title' };
    const fromDdg: Discovery = { ...base, attemptId: 'a-ddg', engineId: 'duckduckgo', title: 'DDG title' };
    const merged = mergeDiscoveries([fromBing], [fromDdg]);
    expect(merged).toEqual([fromBing, fromDdg]);
    expect(merged.map((d) => d.attemptId)).toEqual(['a-bing', 'a-ddg']);
  });
});
