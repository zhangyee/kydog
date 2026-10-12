import path from 'node:path';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { JSDOM } from 'jsdom';
import { z } from 'zod';
import type { FileWriteGuard } from '../agent/charCountFileTools';
import { parseXSourcePost } from './xResearchIdentity';
import {
  projectLegacyXResult,
  type XLegacyProjection,
} from './xResearchLegacy';
import type {
  XArticleEntryIdentity,
  XResearchResult,
  XSourceReference,
} from './xResearchTypes';

const string = z.string().min(1);
const entrySchema = z.object({
  entryObservationId: string,
  parentPostId: string,
  sourceUrl: string,
  targetUrl: z.string().nullable(),
});
const author = z
  .object({
    handle: z.string().nullable(),
    displayName: z.string().nullable(),
    profileUrl: z.string().nullable(),
  })
  .nullable();
const textSchema = z.object({
  observationId: string,
  sourceKind: z.literal('rendered_ui'),
  postId: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  author,
  text: z.string(),
  observedAt: string,
  containerKind: z.enum([
    'root_post',
    'quoted_post',
    'reply',
    'article',
    'unattributed_fragment',
  ]),
  truncation: z.object({
    returned: z.number().int().nonnegative(),
    totalKnown: z.number().int().nonnegative().nullable(),
    truncated: z.boolean(),
  }),
  articlePreviews: z.array(entrySchema).optional(),
});
const documentSchema = z.object({
  urlKind: z.literal('document'),
  sourceUrl: string,
  observationId: string,
  rootObservationId: string.nullable(),
  observedAt: string,
  containerKind: z.enum([
    'root_post',
    'quoted_post',
    'reply',
    'article',
    'unattributed_fragment',
  ]),
  runId: string,
  callId: string,
  batchId: string,
  queryId: z.string().nullable(),
  query: z.string().nullable(),
  purpose: z.string().nullable(),
  product: z.enum(['Top', 'Latest']).nullable(),
});
const articleSchema = z.object({
  requested: z.boolean(),
  entryObserved: z.boolean(),
  actionAttempted: z.boolean(),
  navigationStarted: z.boolean(),
  bodyObserved: z.boolean(),
  entryIdentity: entrySchema.optional(),
  entry: z
    .object({
      observationId: string,
      parentPostId: string,
      sourceUrl: string,
      targetUrl: z.string().nullable(),
    })
    .nullable(),
  body: textSchema.nullable(),
});
const base = {
  schemaVersion: z.literal(2),
  sourceKind: z.literal('rendered_ui'),
  runId: string,
  callId: string,
  batchId: string,
};
const canonicalSchema = z.discriminatedUnion('operation', [
  z.object({
    ...base,
    operation: z.literal('search'),
    queries: z.array(
      z.object({
        query: z.object({
          id: string,
          query: string,
          purpose: string,
          product: z.enum(['Top', 'Latest']),
        }),
        posts: z.array(textSchema),
      }),
    ),
  }),
  z.object({
    ...base,
    operation: z.literal('read'),
    targets: z.array(
      z.object({
        root: textSchema.nullable(),
        quotedPosts: z.array(textSchema),
        replies: z.object({ observations: z.array(textSchema) }),
        article: articleSchema,
        documentSource: z.unknown().optional(),
      }),
    ),
  }),
]);
type Canonical = z.infer<typeof canonicalSchema>;
type Text = z.infer<typeof textSchema>;
export interface XEvidenceObservation {
  sourceKind: 'rendered_ui' | 'legacy_x_graphql';
  origin: 'production' | 'history';
  observationId: string | null;
  observedAt: string | null;
  runId: string | null;
  callId: string | null;
  batchId: string | null;
  sessionEntryId: string | null;
  postId: string;
  sourceUrl: string;
  authorHandle: string;
  text: string;
  containerKind: Text['containerKind'];
  articlePreviews: readonly XArticleEntryIdentity[];
  truncation: Text['truncation'] | null;
}
interface Preview {
  parentUrl: string;
  postId: string;
  identity: XArticleEntryIdentity | null;
}
interface ArticleFamily {
  parentUrl: string;
  postId: string;
  entry: XArticleEntryIdentity;
  attempted: boolean;
  bodySourceUrl: string | null;
}
/** Validate all identity fields from this one container; never fill missing fields from neighbors. */
function named(p: Text): p is Text & {
  postId: string;
  sourceUrl: string;
  author: NonNullable<Text['author']>;
} {
  const source = parseXSourcePost(p.sourceUrl);
  return (
    p.containerKind !== 'unattributed_fragment' &&
    !!source?.handle &&
    source.id === p.postId &&
    source.handle === p.author?.handle &&
    (p.articlePreviews ?? []).every(
      (e) =>
        p.postId !== null &&
        p.sourceUrl !== null &&
        parentEntry(e, { postId: p.postId, sourceUrl: p.sourceUrl }),
    )
  );
}
function parentEntry(
  entry: XArticleEntryIdentity,
  p: { postId: string; sourceUrl: string },
): boolean {
  return (
    entry.parentPostId === p.postId &&
    entry.sourceUrl === p.sourceUrl &&
    (entry.targetUrl === null || parseXSourcePost(entry.targetUrl) !== null)
  );
}
function entryIdentity(
  article: z.infer<typeof articleSchema>,
): XArticleEntryIdentity | undefined {
  const e = article.entry;
  return e
    ? {
        entryObservationId: e.observationId,
        parentPostId: e.parentPostId,
        sourceUrl: e.sourceUrl,
        targetUrl: e.targetUrl,
      }
    : article.entryIdentity;
}
type MarkdownNode = {
  type: string;
  url?: string;
  identifier?: string;
  value?: string;
  children?: MarkdownNode[];
};
/** Use the existing renderer's CommonMark/GFM parser: reference links, autolinks,
 * entity escapes and HTML hrefs have the same meaning here as in the report. */
function citationUrls(content: string): string[] {
  const urls: string[] = [],
    definitions = new Map<string, string>(),
    references: string[] = [];
  Markdown({
    children: content,
    remarkPlugins: [
      remarkGfm,
      () => (tree: MarkdownNode) => {
        const pending = [tree];
        while (pending.length) {
          const n = pending.pop()!;
          if ((n.type === 'link' || n.type === 'image') && n.url)
            urls.push(n.url);
          if (
            n.type === 'definition' &&
            n.identifier &&
            n.url &&
            !definitions.has(n.identifier)
          )
            definitions.set(n.identifier, n.url);
          if (
            (n.type === 'linkReference' || n.type === 'imageReference') &&
            n.identifier
          )
            references.push(n.identifier);
          if (n.type === 'html' && n.value)
            for (const a of JSDOM.fragment(n.value).querySelectorAll(
              'a[href],area[href]',
            ))
              urls.push(a.getAttribute('href')!);
          pending.push(...[...(n.children ?? [])].reverse());
        }
      },
    ],
  });
  for (const ref of references) {
    const url = definitions.get(ref);
    if (url) urls.push(url);
  }
  return [...new Set(urls)];
}
function isXReference(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      /^(?:www\.)?(?:x|twitter)\.com$/i.test(u.hostname) &&
      /\/(?:status|statuses)\//.test(u.pathname)
    );
  } catch {
    return false;
  }
}
/** Session-owned ledger. observe is exclusively a trusted final-tool callback;
 * restore accepts SDK getBranch entries, never model-visible content or summaries.
 * Source coordinates are navigation hints; only validated nonempty bodies authorize citations. */
export class XResearchEvidence {
  readonly sources = new Map<string, XSourceReference[]>();
  private records: XEvidenceObservation[] = [];
  private previews: Preview[] = [];
  private families: ArticleFamily[] = [];
  private attachedLegacyParents = new Set<string>();
  private legacy: XLegacyProjection[] = [];
  constructor(
    private readonly cwd: string,
    private readonly currentRunId: () => string | null,
  ) {}
  get observations(): readonly XEvidenceObservation[] {
    return structuredClone(this.records);
  }
  get legacyProjections(): readonly XLegacyProjection[] {
    return structuredClone(this.legacy);
  }
  get currentRunObservations(): readonly XEvidenceObservation[] {
    const run = this.currentRunId();
    return structuredClone(
      this.records.filter(
        (r) => r.origin === 'production' && run !== null && r.runId === run,
      ),
    );
  }
  observe(result: XResearchResult): void {
    const parsed = canonicalSchema.safeParse(result);
    if (!parsed.success)
      throw new Error(
        'Invalid canonical X research result; no evidence recorded',
      );
    this.addCanonical(parsed.data, 'production', null);
  }
  /** Rebuild, rather than merge, so a changed branch cannot retain obsolete facts. */
  restore(branchEntries: readonly unknown[]): void {
    this.records = [];
    this.previews = [];
    this.families = [];
    this.attachedLegacyParents.clear();
    this.legacy = [];
    this.sources.clear();
    for (const raw of branchEntries) {
      const entry = z
        .object({
          type: z.literal('message'),
          id: z.string().optional(),
          message: z.object({
            role: z.literal('toolResult'),
            toolName: z.literal('x_research'),
            toolCallId: z.string().optional(),
            isError: z.literal(false),
            details: z.unknown(),
          }),
        })
        .safeParse(raw);
      if (!entry.success) continue;
      const { message: m, id } = entry.data;
      const fresh = canonicalSchema.safeParse(m.details);
      if (fresh.success) {
        if (m.toolCallId !== undefined && m.toolCallId !== fresh.data.callId)
          continue;
        this.addCanonical(fresh.data, 'history', id ?? null);
        continue;
      }
      const projection = projectLegacyXResult(m.details);
      this.legacy.push(projection);
      for (const p of projection.posts) {
        this.records.push({
          ...p,
          origin: 'history',
          callId: m.toolCallId ?? null,
          sessionEntryId: id ?? null,
          articlePreviews: [],
          truncation: null,
        });
        const source: XSourceReference = {
          sourceKind: 'legacy_x_graphql',
          urlKind: 'permalink',
          sourceUrl: p.sourceUrl,
          observationId: null,
          rootObservationId: null,
          observedAt: null,
          containerKind: p.containerKind,
          runId: null,
          callId: m.toolCallId ?? null,
          batchId: null,
          sessionEntryId: id ?? null,
          queryId: null,
          query: null,
          purpose: null,
          product: null,
        };
        this.addSource(p.postId, source);
        if (p.articlePreview)
          this.previews.push({
            parentUrl: p.sourceUrl,
            postId: p.postId,
            identity: null,
          });
      }
      for (const a of projection.articles)
        this.attachedLegacyParents.add(a.parent.sourceUrl);
    }
  }
  private addSource(postId: string, source: XSourceReference) {
    const values = this.sources.get(postId) ?? [];
    if (
      !values.some(
        (v) =>
          v.sourceUrl === source.sourceUrl &&
          v.urlKind === source.urlKind &&
          v.observationId === source.observationId &&
          v.callId === source.callId &&
          ('sessionEntryId' in v ? v.sessionEntryId : null) ===
            ('sessionEntryId' in source ? source.sessionEntryId : null),
      )
    )
      values.push(source);
    this.sources.set(postId, values);
  }
  private addCanonical(
    result: Canonical,
    origin: XEvidenceObservation['origin'],
    sessionEntryId: string | null,
  ) {
    const add = (
      p: Text,
      query?: Extract<
        Canonical,
        { operation: 'search' }
      >['queries'][number]['query'],
    ) => {
      if (!named(p)) return;
      const previews = (p.articlePreviews ?? []).filter((e) =>
        parentEntry(e, { postId: p.postId, sourceUrl: p.sourceUrl }),
      );
      this.records.push({
        sourceKind: 'rendered_ui',
        origin,
        sessionEntryId,
        runId: result.runId,
        callId: result.callId,
        batchId: result.batchId,
        observationId: p.observationId,
        observedAt: p.observedAt,
        postId: p.postId,
        sourceUrl: p.sourceUrl,
        authorHandle: p.author.handle!,
        text: p.text,
        containerKind: p.containerKind,
        articlePreviews: previews,
        truncation: p.truncation,
      });
      this.addSource(p.postId, {
        urlKind: 'permalink',
        sourceUrl: p.sourceUrl,
        observationId: p.observationId,
        rootObservationId:
          p.containerKind === 'root_post' ? p.observationId : null,
        observedAt: p.observedAt,
        containerKind: p.containerKind,
        runId: result.runId,
        callId: result.callId,
        batchId: result.batchId,
        queryId: query?.id ?? null,
        query: query?.query ?? null,
        purpose: query?.purpose ?? null,
        product: query?.product ?? null,
      });
      for (const identity of previews)
        this.previews.push({
          parentUrl: p.sourceUrl,
          postId: p.postId,
          identity,
        });
    };
    if (result.operation === 'search') {
      for (const row of result.queries)
        for (const p of row.posts) add(p, row.query);
      return;
    }
    for (const row of result.targets) {
      if (row.root?.containerKind === 'root_post') add(row.root);
      for (const p of row.quotedPosts)
        if (p.containerKind === 'quoted_post') add(p);
      for (const p of row.replies.observations)
        if (p.containerKind === 'reply') add(p);
      const root = row.root,
        body = row.article.body,
        e = entryIdentity(row.article);
      if (body?.containerKind === 'article' && row.article.bodyObserved)
        add(body);
      if (root?.containerKind === 'root_post' && named(root)) {
        const document = documentSchema.safeParse(row.documentSource);
        if (document.success) {
          const d = document.data,
            coordinates = parseXSourcePost(d.sourceUrl);
          if (
            d.rootObservationId === root.observationId &&
            coordinates?.id === root.postId &&
            coordinates.handle === root.author.handle &&
            d.runId === result.runId &&
            d.callId === result.callId &&
            d.batchId === result.batchId
          )
            this.addSource(root.postId, d);
        }
        if (e && parentEntry(e, root)) {
          this.previews.push({
            parentUrl: root.sourceUrl,
            postId: root.postId,
            identity: e,
          });
          this.families.push({
            parentUrl: root.sourceUrl,
            postId: root.postId,
            entry: e,
            attempted: row.article.entryObserved && row.article.actionAttempted,
            bodySourceUrl:
              row.article.bodyObserved &&
              body?.containerKind === 'article' &&
              named(body) &&
              !!body.text.trim() &&
              (e.targetUrl === null || body.sourceUrl === e.targetUrl)
                ? body.sourceUrl
                : null,
          });
        }
      }
    }
  }
  readonly guard: FileWriteGuard = (absolutePath, finalContent) => {
    for (const url of citationUrls(finalContent).filter(isXReference)) {
      const own = this.records.filter(
        (r) =>
          r.sourceUrl === url &&
          (r.text.trim() ||
            (r.sourceKind === 'legacy_x_graphql' &&
              this.attachedLegacyParents.has(url))),
      );
      // A document alias is usable only when it records the exact validated root observation.
      const docs = [...this.sources.values()]
        .flat()
        .filter((s) => s.urlKind === 'document' && s.sourceUrl === url);
      const identities = [
        ...own,
        ...this.records.filter(
          (r) =>
            r.text.trim() &&
            docs.some(
              (d) =>
                d.rootObservationId === r.observationId &&
                d.callId === r.callId &&
                d.batchId === r.batchId,
            ),
        ),
      ];
      if (!identities.length)
        throw new Error(
          `X citation is unobserved or has unproven author/body identity: ${url}`,
        );
      const parentUrls = new Set(identities.map((r) => r.sourceUrl));
      for (const p of this.previews.filter((p) =>
        parentUrls.has(p.parentUrl),
      )) {
        if (this.attachedLegacyParents.has(p.parentUrl)) continue;
        // Select an actual same-item refreshed read family for the parent citation.
        // A href-less old card has unknown continuity; its stored fact is never upgraded.
        // Known target URLs remain distinct even when they share a parent.
        const allowed = this.families.some(
          (f) =>
            f.parentUrl === p.parentUrl &&
            f.postId === p.postId &&
            (f.bodySourceUrl !== null || f.attempted) &&
            (p.identity === null ||
              p.identity.targetUrl === null ||
              p.identity.targetUrl === f.entry.targetUrl ||
              p.identity.targetUrl === f.bodySourceUrl),
        );
        if (!allowed)
          throw new Error(
            `X Article needs an accurate entry read: postId=${p.postId}, entry=${p.identity?.entryObservationId ?? 'unknown (legacy preview)'}, sourceUrl=${p.parentUrl}, targetUrl=${p.identity?.targetUrl ?? 'unknown'}. Read this exact parent/entry before saving.`,
          );
      }
    }
    if (
      /^x-research-.+-\d{4}-\d{2}-\d{2}(?:-[\w-]+)?\.md$/i.test(
        path.basename(path.resolve(this.cwd, absolutePath)),
      )
    )
      return { createOnly: true };
  };
}
