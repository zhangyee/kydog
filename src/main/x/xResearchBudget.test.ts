import { describe, expect, it } from 'vitest';
import { reachedXBudgets, resolveXBudgetPolicy, sampleXEntries } from './xResearchBudget';
import { parseXResearchInput } from './xResearchInput';

const search = { objective: 'research', queries: [{ id: 'q', query: 'paper', purpose: 'verify', product: 'Top' }] };
describe('resource budget policy', () => {
  it('tracks explicit own properties even when equal to defaults, and preserves zero', () => {
    const raw = { search: { ...search, maxPostsPerQuery: 500 } };
    expect(resolveXBudgetPolicy(raw, parseXResearchInput(raw))).toEqual({ posts: { limit: 500, origin: 'explicit' }, scrolls: { limit: 500, origin: 'default' } });
    const zero = { search: { ...search, maxPostsPerQuery: 0, maxScrollsPerQuery: 1000 } };
    expect(resolveXBudgetPolicy(zero, parseXResearchInput(zero))).toEqual({ posts: { limit: 0, origin: 'explicit' }, scrolls: { limit: 1000, origin: 'explicit' } });
    const read = { tabId: 'tab', read: { objective: 'read', targets: [{ postId: '123' }], maxExpandActionsPerPost: 0 } };
    expect(resolveXBudgetPolicy(read, parseXResearchInput(read))).toEqual({ replies: { limit: 500, origin: 'default' }, scrolls: { limit: 500, origin: 'default' }, expands: { limit: 0, origin: 'explicit' } });
  });
  it('simultaneous_caps returns every reached dimension in fixed order', () => {
    const policy = { scrolls: { limit: 500, origin: 'default' as const }, posts: { limit: 500, origin: 'explicit' as const }, network_pages: { limit: 0, origin: 'safety' as const } };
    expect(reachedXBudgets(policy, { posts: 500, scrolls: 501 }, ['scrolls', 'posts'])).toEqual([
      { dimension: 'posts', limit: 500, origin: 'explicit', used: 500 },
      { dimension: 'scrolls', limit: 500, origin: 'default', used: 501 },
    ]);
    expect(reachedXBudgets(policy, { posts: 499, scrolls: 499 }, ['scrolls', 'posts'])).toEqual([]);
  });
  it('samples 501 different IDs in source order and accepts later versions only of admitted IDs', () => {
    const seen = new Set<string>();
    const items = Array.from({ length: 501 }, (_, i) => ({ postId: String(i + 1), text: `body-${i + 1}` }));
    const first = sampleXEntries(items, seen, 500);
    expect(first).toMatchObject({ observed: 501, sampled: 500, omitted: 1 });
    expect(first.retained.map(p => p.postId)).toEqual(items.slice(0, 500).map(p => p.postId));
    expect(seen.size).toBe(500);
    expect(sampleXEntries([{ postId: '1', text: 'updated' }, { postId: '501', text: 'omitted again' }], seen, 500)).toEqual({ retained: [{ postId: '1', text: 'updated' }], observed: 2, sampled: 1, omitted: 1 });
    expect(seen.size).toBe(500);
    expect(sampleXEntries(items, new Set(), 0)).toEqual({ retained: [], observed: 501, sampled: 0, omitted: 501 });
  });
});
