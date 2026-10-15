import type { XReadObservation, XReadRequest, XResearchInput } from './xResearchTypes';

export type XBudgetDimension = 'posts' | 'replies' | 'scrolls' | 'expands' | 'network_pages';
export interface XBudgetLimit { limit: number; origin: 'default' | 'explicit' | 'safety' }
export type XBudgetBinding = XBudgetLimit & { dimension: XBudgetDimension; used: number };
export type XBudgetPolicy = Partial<Record<XBudgetDimension, XBudgetLimit>>;
export const X_RESEARCH_MAX_BUDGET = 1000;
const dimensionOrder: readonly XBudgetDimension[] = ['posts', 'replies', 'scrolls', 'expands', 'network_pages'];

/** Input is already validated. Presence, never numeric equality, identifies an override. */
export function resolveXBudgetPolicy(raw: unknown, input: XResearchInput): XBudgetPolicy {
  const source = raw as { search?: object; read?: object };
  const own = input.search ? source.search : source.read;
  const limit = (key: string, value: number): XBudgetLimit => ({ limit: value, origin: own && Object.hasOwn(own, key) ? 'explicit' : 'default' });
  return input.search ? {
    posts: limit('maxPostsPerQuery', input.search.maxPostsPerQuery),
    scrolls: limit('maxScrollsPerQuery', input.search.maxScrollsPerQuery),
  } : {
    replies: limit('maxRepliesPerPost', input.read.maxRepliesPerPost),
    scrolls: limit('maxScrollsPerPost', input.read.maxScrollsPerPost),
    expands: limit('maxExpandActionsPerPost', input.read.maxExpandActionsPerPost),
  };
}
export function reachedXBudgets(policy: XBudgetPolicy, usage: Partial<Record<XBudgetDimension, number>>, dimensions: readonly XBudgetDimension[]): XBudgetBinding[] {
  return dimensionOrder.flatMap(dimension => {
    const budget = policy[dimension], used = usage[dimension] ?? 0;
    return dimensions.includes(dimension) && budget && used >= budget.limit ? [{ ...budget, dimension, used }] : [];
  });
}
/** Limit counts different admitted IDs across the row; versions keep their source order. */
export function sampleXEntries<T extends { postId: string }>(items: readonly T[], seen: Set<string>, limit: number): { retained: T[]; observed: number; sampled: number; omitted: number } {
  const retained = items.filter(item => {
    if (seen.has(item.postId)) return true;
    if (seen.size >= limit) return false;
    seen.add(item.postId);
    return true;
  });
  return { retained, observed: items.length, sampled: retained.length, omitted: items.length - retained.length };
}
/** Direct callers supplied parsed values explicitly; they carry no raw default provenance. */
export function bindXReadBudgets(row: XReadObservation, limits: XReadRequest, policy: XBudgetPolicy | undefined, dimensions: readonly XBudgetDimension[], sampledEntries?: number): XBudgetBinding[] {
  const effective = policy ?? resolveXBudgetPolicy({ read: limits }, { tabId: '', read: limits });
  const reached = reachedXBudgets(effective, { replies: sampledEntries ?? new Set([...row.replies.observations,...(row.unscopedPosts?.observations??[])].map(item => item.postId)).size, scrolls: row.budgetUsage.scrolls, expands: row.budgetUsage.expandActions }, dimensions);
  if (reached.length) {
    const bindings = new Map((row.budgetBinding ?? []).map(binding => [binding.dimension, binding]));
    for (const binding of reached) bindings.set(binding.dimension, binding);
    row.budgetBinding = dimensionOrder.flatMap(dimension => bindings.has(dimension) ? [bindings.get(dimension)!] : []);
  }
  return reached;
}
