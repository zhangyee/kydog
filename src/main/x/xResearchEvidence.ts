import { replyUiFrameFields, replyUiFrameBindingValid } from './xReplyUiInventory';
import path from 'node:path';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { JSDOM } from 'jsdom';
import { z } from 'zod';
import { sourceRootStateSchema } from './xDomSource';
import type { FileWriteGuard } from '../agent/charCountFileTools';
import { parseXSourcePost, parseXArticleAnalyticsHref, X_MAX_ARTICLE_IDENTITY_HREF_UNITS } from './xResearchIdentity';
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
const inventorySchema=z.object({scope:z.literal('collection'),observed:z.number().int().nonnegative(),retained:z.number().int().nonnegative(),omitted:z.number().int().nonnegative(),unresolved:z.number().int().nonnegative()});
const scopeIdentitySchema=z.object({observationId:string,postId:string,sourceUrl:string,authorHandle:string});
const scopeSchema=scopeIdentitySchema.extend({articlePreviews:z.array(entrySchema),articlePreviewInventory:inventorySchema});
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
  articlePreviewInventory:inventorySchema.optional(),
});
const unscopedTextSchema=textSchema.extend({
  containerKind:z.literal('unscoped_post'),relationToTarget:z.literal('unproven'),observedContainer:z.literal('post'),
  postId:string,sourceUrl:string,author:z.object({handle:string,displayName:z.string().nullable(),profileUrl:z.string().nullable()}),
  text:z.string().max(4000),articlePreviews:z.array(entrySchema).max(0).optional(),
}).refine(p=>{const own=parseXSourcePost(p.sourceUrl);return own?.id===p.postId && own.handle===p.author.handle && !!p.text.trim();});
const unscopedSchema=z.object({
  observations:z.array(unscopedTextSchema).max(100),
  collection:z.object({snapshotId:string,document:z.object({epoch:z.number().int().nonnegative(),routeRevision:z.number().int().nonnegative(),navigationSequence:z.number().int().nonnegative(),generation:string}),location:z.object({origin:z.string().nullable(),path:z.string().nullable(),q:z.string().nullable(),f:z.string().nullable(),fragment:z.string().nullable(),redacted:z.boolean()})}),
  inventory:z.object({scope:z.literal('collection'),observed:z.number().int().min(0).max(100),retained:z.number().int().min(0).max(100),omitted:z.number().int().min(0).max(100),sourceInventoryTruncated:z.boolean(),excludedNestedQuotes:z.number().int().min(0).max(100)}),
  previewGaps:z.array(z.object({sourceUrl:string.refine(url=>!!parseXSourcePost(url)?.handle),unresolved:z.number().int().positive()})).max(100),
}).refine(p=>p.inventory.retained===p.observations.length && p.inventory.observed===p.inventory.retained+p.inventory.omitted);
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
  provenance: z.object({kind:z.literal('direct_open'),navigationId:string,bodyObservationId:string,sourceUrl:string,nativeIdentity:z.object({kind:z.literal('owned_analytics'),href:string.max(X_MAX_ARTICLE_IDENTITY_HREF_UNITS),documentGeneration:string}).optional()}).optional(),
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
const diagnosticFrameSchema=z.object({...replyUiFrameFields,sourceRootState:sourceRootStateSchema.optional()}).refine(replyUiFrameBindingValid);
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
        postObservations:z.array(textSchema).optional(),
      }),
    ),
  }),
  z.object({
    ...base,
    operation: z.literal('read'),
    targets: z.array(
      z.object({
        diagnostics:z.object({initialFrame:diagnosticFrameSchema.optional(),firstAdmittedFrame:diagnosticFrameSchema.optional(),terminalFrame:diagnosticFrameSchema.optional()}).optional(),
        unscopedPosts:unscopedSchema.optional(),
        root: textSchema.nullable(),
        bodyObservations: z.array(textSchema).optional(),
        articlePreviewObservations:z.array(scopeSchema).optional(),
        inventoryAuditOmitted:z.object({count:z.number().int().positive(),first:scopeIdentitySchema}).optional(),
        quotedPosts: z.array(textSchema),
        replies: z.object({ requested:z.boolean().optional(), observations: z.array(textSchema) }),
        article: articleSchema,
        location:z.object({documentGeneration:z.string().nullable()}).optional(),
        documentSource: z.unknown().optional(),
      }).refine(row=>!row.unscopedPosts || row.replies.requested===true),
    ),
  }),
]);
/** Only actual current-branch v2 tool results with a navigation receipt can bind a tab. */
export function latestXResearchTab(branchEntries: readonly unknown[]): string | undefined {
  let tab: string | undefined;
  const envelope = z.object({type:z.literal('message'),message:z.object({role:z.literal('toolResult'),toolName:z.literal('x_research'),toolCallId:string,isError:z.literal(false),details:z.unknown()})});
  const binding = z.object({browserTabId:string,operation:z.enum(['search','read']),queries:z.array(z.unknown()).optional(),targets:z.array(z.unknown()).optional()});
  const row = z.object({location:z.object({committedNavigationOutcome:z.enum(['ok','ok_same_document','failed','cancelled','crashed','download','blocked','superseded','timeout'])})});
  for(const raw of branchEntries) {
    const e=envelope.safeParse(raw);if(!e.success) continue;
    const canonical=canonicalSchema.safeParse(e.data.message.details),b=binding.safeParse(e.data.message.details);
    if(!canonical.success || !b.success || canonical.data.callId!==e.data.message.toolCallId) continue;
    if((b.data.operation==='search'?b.data.queries:b.data.targets)?.some(value=>row.safeParse(value).success)) tab=b.data.browserTabId;
  }
  return tab;
}
type Canonical = z.infer<typeof canonicalSchema>;
type Text = z.infer<typeof textSchema> | z.infer<typeof unscopedTextSchema>;
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
  relationToTarget?: 'unproven';
  observedContainer?: 'post';
  articlePreviews: readonly XArticleEntryIdentity[];
  articlePreviewInventory?:Text['articlePreviewInventory'];
  truncation: Text['truncation'] | null;
}
interface Preview {
  parentUrl: string;
  postId: string;
  identity: XArticleEntryIdentity | null;
  /** Only this exact legacy item may use its directly attached body. */
  legacyRecord?: XEvidenceObservation;
}
interface ArticleFamily {
  rootRecord: XEvidenceObservation;
  order:number;
  completeInventory:boolean;
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
    (!p.articlePreviewInventory || (p.articlePreviewInventory.observed===p.articlePreviewInventory.retained+p.articlePreviewInventory.omitted && p.articlePreviewInventory.retained===(p.articlePreviews?.length??0))) &&
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
  private resultOrder=0;
  private inventoryGaps:{sourceUrl:string;postId:string;observationId:string;order:number}[]=[];
  private previews: Preview[] = [];
  private families: ArticleFamily[] = [];
  private attachedLegacyRecords = new Set<XEvidenceObservation>();
  /** Final canonical aliases, isolated from the mutable navigation-hint map. */
  private documentAliases: Readonly<{
    sourceUrl: string;
    root: XEvidenceObservation;
  }>[] = [];
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
    this.resultOrder=0;this.inventoryGaps=[];
    this.previews = [];
    this.families = [];
    this.attachedLegacyRecords.clear();
    this.documentAliases = [];
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
        const record: XEvidenceObservation = {
          ...p,
          origin: 'history',
          callId: m.toolCallId ?? null,
          sessionEntryId: id ?? null,
          articlePreviews: [],
          truncation: null,
        };
        this.records.push(record);

        if (projection.articles.some((a) => a.parent === p))
          this.attachedLegacyRecords.add(record);
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
            legacyRecord: record,
          });
      }
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
    const order=++this.resultOrder;
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
      const record: XEvidenceObservation = {
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
        ...(p.containerKind==='unscoped_post'?{relationToTarget:p.relationToTarget,observedContainer:p.observedContainer}:{}),
        articlePreviews: previews,
        ...(p.articlePreviewInventory?{articlePreviewInventory:p.articlePreviewInventory}:{}),
        truncation: p.truncation,
      };
      this.records.push(record);
      if(p.articlePreviewInventory && (p.articlePreviewInventory.omitted>0 || p.articlePreviewInventory.unresolved>0))this.inventoryGaps.push({sourceUrl:p.sourceUrl,postId:p.postId,observationId:p.observationId,order});
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
      return record;
    };
    if (result.operation === 'search') {
      for (const row of result.queries)
        for (const p of [...row.posts,...(row.postObservations??[])]) add(p, row.query);
      return;
    }
    for (const row of result.targets) {
      if(row.unscopedPosts) {
        for(const gap of row.unscopedPosts.previewGaps) {
          const own=parseXSourcePost(gap.sourceUrl)!;
          this.inventoryGaps.push({sourceUrl:gap.sourceUrl,postId:own.id,observationId:row.unscopedPosts.collection.snapshotId,order});
        }
        for(const p of row.unscopedPosts.observations) add(p);
      }
      for(const scope of row.articlePreviewObservations??[]) {
        const coordinates=parseXSourcePost(scope.sourceUrl),inventory=scope.articlePreviewInventory;
        if(coordinates?.id!==scope.postId || coordinates.handle!==scope.authorHandle || inventory.observed!==inventory.retained+inventory.omitted || inventory.retained!==scope.articlePreviews.length || !scope.articlePreviews.every(entry=>parentEntry(entry,scope))) continue;
        for(const identity of scope.articlePreviews)this.previews.push({parentUrl:scope.sourceUrl,postId:scope.postId,identity});
        if(inventory.omitted>0 || inventory.unresolved>0)this.inventoryGaps.push({...scope,order});
      }
      if(row.inventoryAuditOmitted) {
        const scope=row.inventoryAuditOmitted.first,coordinates=parseXSourcePost(scope.sourceUrl);
        if(coordinates?.id===scope.postId && coordinates.handle===scope.authorHandle)this.inventoryGaps.push({...scope,order});
      }
      for (const p of row.bodyObservations ?? []) add(p);
      const rootRecord =
        row.root?.containerKind === 'root_post' ? add(row.root) : undefined;
      for (const p of row.quotedPosts)
        if (p.containerKind === 'quoted_post') add(p);
      for (const p of row.replies.observations)
        if (p.containerKind === 'reply') add(p);
      const root = row.root,
        body = row.article.body,
        e = entryIdentity(row.article);
      const native=row.article.provenance?.nativeIdentity;
      const nativeCoordinates=native && body?.sourceUrl ? parseXArticleAnalyticsHref(native.href,body.sourceUrl) : null;
      const nativeValid=!native || (!!nativeCoordinates && nativeCoordinates.id===body?.postId && nativeCoordinates.handle===body?.author?.handle
        && native.documentGeneration===row.location?.documentGeneration);
      if (nativeValid && body?.containerKind === 'article' && row.article.bodyObserved
        && (!row.article.provenance || (row.article.provenance.bodyObservationId===body.observationId
          && row.article.provenance.sourceUrl===body.sourceUrl && !row.article.entryObserved
          && !row.article.actionAttempted && !row.article.navigationStarted))) add(body);
      if (root?.containerKind === 'root_post' && named(root)) {
        const document = documentSchema.safeParse(row.documentSource);
        if (document.success) {
          const d = document.data,
            coordinates = parseXSourcePost(d.sourceUrl);
          if (
            rootRecord &&
            d.rootObservationId === root.observationId &&
            coordinates?.id === root.postId &&
            coordinates.handle === root.author.handle &&
            d.runId === result.runId &&
            d.callId === result.callId &&
            d.batchId === result.batchId
          ) {
            this.documentAliases.push(
              Object.freeze({ sourceUrl: d.sourceUrl, root: rootRecord }),
            );
            this.addSource(root.postId, d);
          }
        }
        if (rootRecord && e && parentEntry(e, root)) {
          this.previews.push({
            parentUrl: root.sourceUrl,
            postId: root.postId,
            identity: e,
          });
          this.families.push({
            rootRecord,order,
            completeInventory:!!root.articlePreviewInventory && root.articlePreviewInventory.omitted===0 && root.articlePreviewInventory.unresolved===0,
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
              this.attachedLegacyRecords.has(r))),
      );
      // These direct same-row bindings were admitted from canonical details only.
      // Public sources can be prepopulated/mutated by producers and never authorize citations.
      const identities = [
        ...own,
        ...this.documentAliases
          .filter((a) => a.sourceUrl === url && a.root.text.trim())
          .map((a) => a.root),
      ];
      if (!identities.length)
        throw new Error(
          `X citation is unobserved or has unproven author/body identity: ${url}`,
        );
      const parentUrls = new Set(identities.map((r) => r.sourceUrl));
      for(const gap of this.inventoryGaps.filter(r=>parentUrls.has(r.sourceUrl))) {
        const newer=this.families.some(f=>f.parentUrl===gap.sourceUrl && f.postId===gap.postId && f.completeInventory && (f.attempted || f.bodySourceUrl!==null) && f.order>gap.order);
        if(!newer) throw new Error(`X Article inventory is unknown: postId=${gap.postId}, sourceUrl=${gap.sourceUrl}, observationId=${gap.observationId}. Obtain a new complete same-parent collection and accurate entry attempt, or omit this parent citation.`);
      }
      for (const p of this.previews.filter((p) =>
        parentUrls.has(p.parentUrl),
      )) {
        if (p.legacyRecord && this.attachedLegacyRecords.has(p.legacyRecord))
          continue;
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
