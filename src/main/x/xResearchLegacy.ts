import { z } from 'zod';
import { parseXSourcePost } from './xResearchIdentity';

const postSchema = z.object({
  id: z.string(),
  url: z.string(),
  author: z.object({ handle: z.string() }),
  text: z.string(),
  articlePreview: z
    .object({ title: z.string().optional(), id: z.string().optional() })
    .optional(),
});
const articleSchema = z.object({
  status: z.literal('present'),
  title: z.string().optional(),
  plainText: z.string(),
  blocks: z.array(
    z.object({ key: z.string(), type: z.string(), text: z.string() }),
  ),
});
const navigationSchema = z.object({
  navigationId: z.string().min(1),
  outcome: z.enum([
    'failed',
    'timeout',
    'ok',
    'ok_same_document',
    'cancelled',
    'superseded',
    'crashed',
    'download',
    'blocked',
  ]),
});
const itemSchema = z.object({
  postId: z.string(),
  root: z.unknown().optional(),
  quotedPost: z.unknown().optional(),
  replies: z.array(z.object({ post: z.unknown() })).optional(),
  article: z.unknown().optional(),
  articleReadAttempted: z.boolean().optional(),
  coverage: z
    .object({
      replyCursorExhausted: z.boolean().nullable(),
      truncated: z.boolean(),
      reason: z.string().optional(),
    })
    .optional(),
  errors: z.array(z.object({ navigation: z.unknown().optional() })).optional(),
});
export interface XLegacyPost {
  sourceKind: 'legacy_x_graphql';
  postId: string;
  sourceUrl: string;
  authorHandle: string;
  text: string;
  containerKind: 'root_post' | 'quoted_post' | 'reply';
  articlePreview: boolean;
  observationId: null;
  observedAt: null;
  runId: null;
  batchId: null;
}
export interface XLegacyProjection {
  sourceKind: 'legacy_x_graphql';
  posts: XLegacyPost[];
  articles: {
    /** Direct reference to the same projected item root; never a URL-based join. */
    parent: XLegacyPost;
    independentIdentity: null;
    title: string | null;
    plainText: string;
    blocks: { key: string; type: string; text: string }[];
  }[];
  parentNavigations: {
    postId: string;
    attempted: boolean | null;
    navigationId: string | null;
    outcome: string | null;
  }[];
  coverage: {
    postId: string;
    replyCursorExhausted: boolean | null;
    truncated: boolean | null;
    reason: string | null;
  }[];
}
/** Explicit DTO whitelist only. No parser/capture replay and no cross-item joins.
 * Legacy Article blocks are attached to the returned same-item root. That association
 * proves neither an independent Article URL nor its author/ID. */
export function projectLegacyXResult(raw: unknown): XLegacyProjection {
  const out: XLegacyProjection = {
    sourceKind: 'legacy_x_graphql',
    posts: [],
    articles: [],
    parentNavigations: [],
    coverage: [],
  };
  const batch = z
    .object({
      schemaVersion: z.literal(1),
      operation: z.enum(['search', 'read']),
      posts: z.array(z.unknown()).optional(),
      items: z.array(z.unknown()).optional(),
    })
    .safeParse(raw);
  if (!batch.success) return out;
  const add = (
    rawPost: unknown,
    containerKind: XLegacyPost['containerKind'],
  ): XLegacyPost | null => {
    const p = postSchema.safeParse(rawPost);
    if (!p.success) return null;
    const coordinates = parseXSourcePost(p.data.url);
    if (
      !coordinates?.handle ||
      coordinates.id !== p.data.id ||
      coordinates.handle !== p.data.author.handle
    )
      return null;
    const value: XLegacyPost = {
      sourceKind: 'legacy_x_graphql',
      postId: p.data.id,
      sourceUrl: p.data.url,
      authorHandle: p.data.author.handle,
      text: p.data.text,
      containerKind,
      articlePreview: p.data.articlePreview !== undefined,
      observationId: null,
      observedAt: null,
      runId: null,
      batchId: null,
    };
    out.posts.push(value);
    return value;
  };
  if (batch.data.operation === 'search')
    for (const p of batch.data.posts ?? []) add(p, 'root_post');
  else
    for (const rawItem of batch.data.items ?? []) {
      const parsed = itemSchema.safeParse(rawItem);
      if (!parsed.success) continue;
      const item = parsed.data;
      const root = add(item.root, 'root_post');
      add(item.quotedPost, 'quoted_post');
      for (const reply of item.replies ?? []) add(reply.post, 'reply');
      const article = articleSchema.safeParse(item.article);
      if (
        root?.postId === item.postId &&
        article.success &&
        (article.data.plainText.trim() ||
          article.data.blocks.some((b) => b.text.trim()))
      )
        out.articles.push({
          parent: root,
          independentIdentity: null,
          title: article.data.title ?? null,
          plainText: article.data.plainText,
          blocks: article.data.blocks,
        });
      const navs = (item.errors ?? [])
        .map((e) => navigationSchema.safeParse(e.navigation))
        .filter((p) => p.success)
        .map((p) => p.data);
      for (const nav of navs.length ? navs : [null])
        out.parentNavigations.push({
          postId: item.postId,
          attempted: item.articleReadAttempted ?? null,
          navigationId: nav?.navigationId ?? null,
          outcome: nav?.outcome ?? null,
        });
      out.coverage.push({
        postId: item.postId,
        replyCursorExhausted: item.coverage?.replyCursorExhausted ?? null,
        truncated: item.coverage?.truncated ?? null,
        reason: item.coverage?.reason ?? null,
      });
    }
  return out;
}
