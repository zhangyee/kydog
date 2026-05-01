import { describe, it, expect } from 'vitest';
import { PROVIDER_CATALOG, getCatalogEntry } from './catalog';

describe('PROVIDER_CATALOG', () => {
  it('共 22 行：5 OAuth + 14 API key + 3 Cloud', () => {
    const oauth = PROVIDER_CATALOG.filter((e) => e.kind === 'oauth');
    const key = PROVIDER_CATALOG.filter((e) => e.kind === 'apiKey');
    const cloud = PROVIDER_CATALOG.filter((e) => e.kind === 'cloud');
    expect(oauth).toHaveLength(5);
    expect(key).toHaveLength(14);
    expect(cloud).toHaveLength(3);
    expect(PROVIDER_CATALOG).toHaveLength(22);
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
