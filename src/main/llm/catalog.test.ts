import { describe, it, expect } from 'vitest';
import { PROVIDER_CATALOG, getCatalogEntry } from './catalog';

describe('PROVIDER_CATALOG', () => {
  it('共 20 行：2 OAuth + 15 API key + 3 Cloud（anthropic 是混合行）', () => {
    const oauth = PROVIDER_CATALOG.filter((e) => e.kind === 'oauth');
    const key = PROVIDER_CATALOG.filter((e) => e.kind === 'apiKey');
    const cloud = PROVIDER_CATALOG.filter((e) => e.kind === 'cloud');
    expect(oauth).toHaveLength(2);
    expect(key).toHaveLength(15);
    expect(cloud).toHaveLength(3);
    expect(PROVIDER_CATALOG).toHaveLength(20);
  });

  // pi 0.83 删掉了这两个内置 provider，留在 catalog 里就是点了必然失败的死链接。
  // 钉住它们不再回来 —— 除非上游哪天恢复支持，那时这条测试会提醒改动的人先去核实。
  it('不再挂着 pi 0.83 已移除的 Gemini CLI / Antigravity', () => {
    const ids = PROVIDER_CATALOG.map((e) => e.id);
    expect(ids).not.toContain('google-gemini-cli');
    expect(ids).not.toContain('google-antigravity');
    // Gemini 本身没被牵连：API key 那条路还在。
    expect(ids).toContain('google');
  });

  it('每个 entry 都有 displayName 与 group', () => {
    for (const e of PROVIDER_CATALOG) {
      expect(e.displayName).toBeTruthy();
      expect(['subscription', 'apiKey', 'cloud']).toContain(e.group);
    }
  });

  it('OAuth entry 必有 oauth.piProviderId', () => {
    for (const e of PROVIDER_CATALOG.filter((x) => x.kind === 'oauth')) {
      expect(e.oauth?.piProviderId).toBeTruthy();
    }
  });

  it('Cloud entry 必有 cloud.cfgKind', () => {
    const expected = new Set(['azure', 'bedrock', 'vertex']);
    for (const e of PROVIDER_CATALOG.filter((x) => x.kind === 'cloud')) {
      expect(expected.has(e.cloud!.cfgKind)).toBe(true);
    }
  });

  it('API key entry 标注 baseUrlOverridable', () => {
    for (const e of PROVIDER_CATALOG.filter((x) => x.kind === 'apiKey')) {
      expect(typeof e.apiKey?.baseUrlOverridable).toBe('boolean');
    }
  });

  it('id 唯一', () => {
    const ids = PROVIDER_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('getCatalogEntry: 命中返回；不存在返回 undefined', () => {
    expect(getCatalogEntry('anthropic')?.displayName).toBe('Anthropic');
    expect(getCatalogEntry('nonexistent')).toBeUndefined();
  });
});
