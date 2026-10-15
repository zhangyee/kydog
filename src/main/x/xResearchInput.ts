import { X_RESEARCH_MAX_BUDGET } from './xResearchBudget';
import { isXPostId, isXPostUrl } from './xResearchIdentity';
import type { XReadTarget, XResearchInput, XSearchQuery } from './xResearchTypes';

/** Shared by parsing and the model-facing budget descriptions. */
export const X_RESEARCH_DEFAULT_BUDGETS = {
  maxPostsPerQuery: 500, maxScrollsPerQuery: 500,
  maxRepliesPerPost: 500, maxScrollsPerPost: 500, maxExpandActionsPerPost: 500,
} as const;

function object(raw: unknown, keys: string[], context: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${context}: expected an object`);
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${context}: unknown field ${key}`);
  return value;
}
function text(raw: unknown, context: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(`${context}: expected non-empty text`);
  return raw;
}
function budget(raw: unknown, fallback: number, max: number, context: string): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > max) throw new Error(`${context}: expected integer from 0 to ${max}`);
  return raw;
}
function flag(raw: unknown, context: string): boolean {
  if (raw === undefined) return true;
  if (typeof raw !== 'boolean') throw new Error(`${context}: expected boolean`);
  return raw;
}
function list(raw: unknown, max: number, context: string): unknown[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > max) throw new Error(`${context}: expected 1–${max} entries`);
  return raw;
}
export function parseXResearchInput(raw: unknown): XResearchInput {
  const input = object(raw, ['tabId', 'search', 'read'], 'x_research');
  if (Object.hasOwn(input, 'search') === Object.hasOwn(input, 'read')) throw new Error('x_research: provide exactly one of search/read');
  const tabId = input.tabId === undefined ? undefined : text(input.tabId, 'tabId');
  if (Object.hasOwn(input, 'search')) {
    const search = object(input.search, ['objective', 'queries', 'maxPostsPerQuery', 'maxScrollsPerQuery'], 'search');
    const seen = new Set<string>();
    const queries = list(search.queries, 6, 'queries').map((raw): XSearchQuery => {
      const query = object(raw, ['id', 'query', 'purpose', 'product'], 'query');
      const id = text(query.id, 'query.id');
      if (seen.has(id)) throw new Error('query.id: duplicate ID');
      seen.add(id);
      if (query.product !== 'Top' && query.product !== 'Latest') throw new Error('query.product: expected Top/Latest');
      return { id, query: text(query.query, 'query.query'), purpose: text(query.purpose, 'query.purpose'), product: query.product };
    });
    return { ...(tabId === undefined ? {} : { tabId }), search: { objective: text(search.objective, 'objective'), queries, maxPostsPerQuery: budget(search.maxPostsPerQuery, X_RESEARCH_DEFAULT_BUDGETS.maxPostsPerQuery, X_RESEARCH_MAX_BUDGET, 'maxPostsPerQuery'), maxScrollsPerQuery: budget(search.maxScrollsPerQuery, X_RESEARCH_DEFAULT_BUDGETS.maxScrollsPerQuery, X_RESEARCH_MAX_BUDGET, 'maxScrollsPerQuery') } };
  }
  if (tabId === undefined) throw new Error('read: top-level tabId is required');
  const read = object(input.read, ['objective', 'targets', 'includeArticle', 'includeReplies', 'maxRepliesPerPost', 'maxScrollsPerPost', 'maxExpandActionsPerPost'], 'read');
  const targets = list(read.targets, 20, 'targets').map((raw): XReadTarget => {
    const target = object(raw, ['postId', 'url'], 'target');
    if (Object.hasOwn(target, 'postId') === Object.hasOwn(target, 'url')) throw new Error('target: provide exactly one of postId/url');
    if (Object.hasOwn(target, 'postId')) {
      const postId = text(target.postId, 'postId');
      if (!isXPostId(postId)) throw new Error('postId: expected numeric X post ID');
      return { postId };
    }
    const url = text(target.url, 'url');
    if (!isXPostUrl(url)) throw new Error('url: expected HTTPS public X post URL');
    return { url };
  });
  return { tabId, read: { objective: text(read.objective, 'objective'), targets, includeArticle: flag(read.includeArticle, 'includeArticle'), includeReplies: flag(read.includeReplies, 'includeReplies'), maxRepliesPerPost: budget(read.maxRepliesPerPost, X_RESEARCH_DEFAULT_BUDGETS.maxRepliesPerPost, X_RESEARCH_MAX_BUDGET, 'maxRepliesPerPost'), maxScrollsPerPost: budget(read.maxScrollsPerPost, X_RESEARCH_DEFAULT_BUDGETS.maxScrollsPerPost, X_RESEARCH_MAX_BUDGET, 'maxScrollsPerPost'), maxExpandActionsPerPost: budget(read.maxExpandActionsPerPost, X_RESEARCH_DEFAULT_BUDGETS.maxExpandActionsPerPost, X_RESEARCH_MAX_BUDGET, 'maxExpandActionsPerPost') } };
}
