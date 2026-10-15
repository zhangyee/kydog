import { z } from 'zod';
import {
  parseXSourcePost,
  X_MAX_ARTICLE_IDENTITY_HREF_UNITS,
} from './xResearchIdentity';
import { sourceRootStateSchema } from './xDomSource';
import {
  replyUiFrameFields,
  replyUiFrameBindingValid,
} from './xReplyUiInventory';
import {
  actionDiagnosticFields,
  searchActionDiagnosticsSchema,
  projectActionDiagnostics,
} from './xActionDiagnostics';
import type {
  XArticleFacts,
  XArticleEntryIdentity,
  XResearchResult,
} from './xResearchTypes';

const string = z.string().min(1);
const count = z.number().int().nonnegative().safe();
export const entrySchema = z.object({
  entryObservationId: string,
  parentPostId: string,
  sourceUrl: string,
  targetUrl: z.string().nullable(),
});
export const author = z
  .object({
    handle: z.string().nullable(),
    displayName: z.string().nullable(),
    profileUrl: z.string().nullable(),
  })
  .nullable();
export const inventorySchema = z.object({
  scope: z.literal('collection'),
  observed: z.number().int().nonnegative(),
  retained: z.number().int().nonnegative(),
  omitted: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
});
export const scopeIdentitySchema = z.object({
  observationId: string,
  postId: string,
  sourceUrl: string,
  authorHandle: string,
});
export const scopeSchema = scopeIdentitySchema.extend({
  articlePreviews: z.array(entrySchema),
  articlePreviewInventory: inventorySchema,
});
export const evidenceTextSchema = z.object({
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
  articlePreviewInventory: inventorySchema.optional(),
});
export const unscopedTextSchema = evidenceTextSchema
  .extend({
    containerKind: z.literal('unscoped_post'),
    relationToTarget: z.literal('unproven'),
    observedContainer: z.literal('post'),
    postId: string,
    sourceUrl: string,
    author: z.object({
      handle: string,
      displayName: z.string().nullable(),
      profileUrl: z.string().nullable(),
    }),
    text: z.string().max(4000),
    articlePreviews: z.array(entrySchema).max(0).optional(),
  })
  .refine((p) => {
    const own = parseXSourcePost(p.sourceUrl);
    return (
      own?.id === p.postId && own.handle === p.author.handle && !!p.text.trim()
    );
  });
export const unscopedSchema = z
  .object({
    observations: z.array(unscopedTextSchema).max(100),
    collection: z.object({
      snapshotId: string,
      document: z.object({
        epoch: z.number().int().nonnegative(),
        routeRevision: z.number().int().nonnegative(),
        navigationSequence: z.number().int().nonnegative(),
        generation: string,
      }),
      location: z.object({
        origin: z.string().nullable(),
        path: z.string().nullable(),
        q: z.string().nullable(),
        f: z.string().nullable(),
        fragment: z.string().nullable(),
        redacted: z.boolean(),
      }),
    }),
    inventory: z.object({
      scope: z.literal('collection'),
      observed: z.number().int().min(0).max(100),
      retained: z.number().int().min(0).max(100),
      omitted: z.number().int().min(0).max(100),
      sourceInventoryTruncated: z.boolean(),
      excludedNestedQuotes: z.number().int().min(0).max(100),
    }),
    previewGaps: z
      .array(
        z.object({
          sourceUrl: string.refine((url) => !!parseXSourcePost(url)?.handle),
          unresolved: z.number().int().positive(),
        }),
      )
      .max(100),
  })
  .refine(
    (p) =>
      p.inventory.retained === p.observations.length &&
      p.inventory.observed === p.inventory.retained + p.inventory.omitted,
  );

const status = z.enum([
  'observed',
  'partial',
  'explicit_empty',
  'auth_required',
  'action_required',
  'rate_limited',
  'access_denied',
  'unavailable',
  'cancelled',
  'failed',
]);
const stop = z.enum([
  'explicit_ui_end',
  'budget_reached',
  'action_failed',
  'navigation_failed',
  'identity_unproven',
  'wait_timeout',
  'access_barrier',
  'cancelled',
  'agent_stopped',
]);
const truncation = evidenceTextSchema.shape.truncation;
const branch = z
  .object({ postId: z.string().nullable(), sourceUrl: z.string().nullable() })
  .nullable();
const sort = z
  .object({ label: z.string(), value: z.string().nullable() })
  .nullable();
const textSchema = z
  .discriminatedUnion('containerKind', [
    evidenceTextSchema.extend({
      containerKind: z.literal('root_post'),
      postId: string,
    }),
    evidenceTextSchema.extend({
      containerKind: z.literal('quoted_post'),
      postId: string,
    }),
    evidenceTextSchema.extend({
      containerKind: z.literal('reply'),
      postId: string,
      directParent: branch,
    }),
    evidenceTextSchema.extend({ containerKind: z.literal('article') }),
    evidenceTextSchema.extend({
      containerKind: z.literal('unattributed_fragment'),
    }),
  ])
  .refine(
    (p) =>
      !p.articlePreviewInventory ||
      (p.articlePreviewInventory.observed ===
        p.articlePreviewInventory.retained +
          p.articlePreviewInventory.omitted &&
        p.articlePreviewInventory.retained ===
          (p.articlePreviews?.length ?? 0)),
  );
const safeLocation = z.object({
  origin: z.string().nullable(),
  path: z.string().nullable(),
  q: z.string().nullable(),
  f: z.string().nullable(),
  fragment: z.string().nullable(),
  redacted: z.boolean(),
});
const relationValue = z.enum(['same', 'different', 'unknown']);
const relation = z.object({
  origin: relationValue,
  path: relationValue,
  postId: relationValue,
  query: relationValue,
  product: relationValue,
  fragment: relationValue,
});
const location = z.object({
  committedNavigationOutcome: z
    .enum([
      'ok',
      'ok_same_document',
      'failed',
      'cancelled',
      'crashed',
      'download',
      'blocked',
      'superseded',
      'timeout',
    ])
    .nullable(),
  requested: safeLocation,
  committed: safeLocation.nullable(),
  subsequent: safeLocation.nullable(),
  relation,
  documentGeneration: z.string().nullable(),
  navigationEvent: z.string().nullable(),
});
const collectionLocation = z.object({
  location: safeLocation,
  documentEpoch: count,
  routeRevision: count,
  navigationSequence: count,
  navigationEvent: z.string().nullable(),
});
const transition = z.object({
  navigationPhase: z
    .enum(['initial_post', 'article', 'return_post'])
    .optional(),
  navigationId: string.optional(),
  stage: z.enum(['search', 'post', 'article']),
  before: collectionLocation,
  after: collectionLocation,
  relation,
  rereadRequested: z.boolean(),
  outcome: z.enum([
    'same_url_generation_changed',
    'route_changed',
    'generation_unchanged',
    'cancelled',
    'repeated_invalidation',
  ]),
});
const barrier = z
  .object({ status, reason: z.string(), observationId: string.nullable() })
  .nullable();
const usage = z.object({
  scrolls: count,
  expandActions: count,
  distinctEntries: count,
  outputBytes: count,
});
const frame = z
  .object({
    ...replyUiFrameFields,
    sourceRootState: sourceRootStateSchema.optional(),
    stage: z.literal('post'),
    snapshotId: string,
    location: safeLocation,
    document: z.object({
      epoch: count,
      routeRevision: count,
      navigationSequence: count,
      generation: string,
    }),
    rawUrlMatchesPort: z.boolean(),
    requestPostMatchesLocation: z.boolean(),
    regionObserved: z.boolean(),
    inventory: truncation,
    rootCandidateCount: count,
    regionNodeId: count.nullable(),
    rootNodeId: count.nullable(),
    rootRejections: z.object({
      unnamed: count,
      authorMismatch: count,
      permalinkMismatch: count,
    }),
    rootIdentityProven: z.boolean(),
    replyCount: count,
    repliesExpandControlCount: count,
    explicitEndObserved: z.boolean(),
  })
  .refine(replyUiFrameBindingValid);
const readinessCounts = z.object({
  replyCount: count,
  expandControlCount: count,
  explicitEndObserved: z.boolean(),
});
const readDiagnostics = z.object({
  ...actionDiagnosticFields,
  version: z.literal(1),
  initialFrame: frame.optional(),
  firstAdmittedFrame: frame.optional(),
  terminalFrame: frame.optional(),
  readiness: z
    .object({
      collectCount: count,
      initial: readinessCounts,
      terminal: readinessCounts,
      timedOut: z.boolean(),
    })
    .optional(),
});
const endEvidence = z.object({
  observationId: string,
  text: z.string(),
  sourceUrl: string,
  observedAt: string,
  rootPostId: string,
  branch,
  sort,
});
const scopeFields = {
  rootPostId: z.string().nullable(),
  branch,
  sort,
  stopReason: stop,
  displayedReplyCount: z
    .object({ text: z.string(), value: z.number().finite().nullable() })
    .nullable(),
};
const replyScope = z.discriminatedUnion('completeness', [
  z.object({
    ...scopeFields,
    completeness: z.literal('unknown'),
    endEvidence: endEvidence.nullable(),
  }),
  z.object({
    ...scopeFields,
    completeness: z.literal('ui_scope_end_observed'),
    endEvidence,
  }),
]);
const observedSource = z.object({
  urlKind: z.enum(['permalink', 'document']),
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
    'unscoped_post',
  ]),
  runId: string,
  callId: string,
  batchId: string,
  queryId: z.string().nullable(),
  query: z.string().nullable(),
  purpose: z.string().nullable(),
  product: z.enum(['Top', 'Latest']).nullable(),
});
const article = z
  .object({
    provenance: z
      .object({
        kind: z.literal('direct_open'),
        navigationId: string,
        bodyObservationId: string,
        sourceUrl: string,
        nativeIdentity: z
          .object({
            kind: z.literal('owned_analytics'),
            href: string.max(X_MAX_ARTICLE_IDENTITY_HREF_UNITS),
            documentGeneration: string,
          })
          .optional(),
      })
      .optional(),
    entryIdentity: entrySchema.optional(),
    location: location.optional(),
    requested: z.boolean(),
    entryObserved: z.boolean(),
    actionAttempted: z.boolean(),
    navigationStarted: z.boolean(),
    bodyObserved: z.boolean(),
    // Entry coordinates may authorize live actions. Persist only its public identity.
    entry: z
      .object({
        observationId: string,
        parentPostId: string,
        sourceUrl: string,
        targetUrl: z.string().nullable(),
      })
      .nullable(),
    body: textSchema.nullable(),
    barrier,
  })
  .transform((value) => ({
    ...value,
    ...(value.entry
      ? { entryIdentity: publicXArticleEntryIdentity(value) }
      : {}),
    entry: null,
  }));
const rowFields = {
  collectionTransitions: z.array(transition),
  status,
  stopReason: stop,
  budgetUsage: usage,
  location: location.nullable(),
  barrier,
  budgetBinding: z
    .array(
      z.object({
        dimension: z.enum([
          'posts',
          'replies',
          'scrolls',
          'expands',
          'network_pages',
        ]),
        used: count,
        limit: count,
        origin: z.enum(['default', 'explicit', 'safety']),
      }),
    )
    .optional(),
  sampleTruncation: z
    .object({ observed: count, sampled: count, omitted: count })
    .refine((v) => v.observed === v.sampled + v.omitted)
    .optional(),
  collectionStop: z
    .object({ status, stopReason: stop, reason: z.string().nullable() })
    .optional(),
};
const searchRow = z.object({
  ...rowFields,
  query: z.object({
    id: string,
    query: string,
    purpose: string,
    product: z.enum(['Top', 'Latest']),
  }),
  posts: z.array(textSchema),
  postObservations: z.array(textSchema).optional(),
  postObservationsOmitted: count.optional(),
  diagnostics: searchActionDiagnosticsSchema.optional(),
});
const readRow = z
  .object({
    ...rowFields,
    target: z.union([z.object({ postId: string }), z.object({ url: string })]),
    documentSource: observedSource.nullable(),
    inputKind: z.enum(['url', 'postId']),
    inputUrlRedacted: z.boolean(),
    postId: z.string().nullable(),
    inputUrl: z.string().nullable(),
    sourceUrl: z.string().nullable(),
    sourceUrlReference: z.literal('root.sourceUrl').optional(),
    reason: z.string().nullable(),
    root: textSchema.nullable(),
    quotedPosts: z.array(textSchema),
    article,
    replies: z.object({
      requested: z.boolean(),
      observations: z.array(textSchema),
      scope: replyScope,
    }),
    unscopedPosts: unscopedSchema.optional(),
    diagnostics: readDiagnostics.optional(),
    bodyObservations: z.array(textSchema).optional(),
    bodyObservationsOmitted: count.optional(),
    articlePreviewObservations: z.array(scopeSchema).optional(),
    inventoryAuditOmitted: z
      .object({ count: count.positive(), first: scopeIdentitySchema })
      .optional(),
  })
  .refine((row) => !row.unscopedPosts || row.replies.requested);
const reportScope = z.object({
  version: z.literal(1),
  operation: z.enum(['search', 'read']),
  reasonSource: z.enum(['barrier.reason', 'reason']),
  totalRows: count,
  statusCounts: z.partialRecord(status, count),
  stopReasonCounts: z.partialRecord(stop, count),
  reasonCounts: z.record(z.string(), count),
  replyScopeCounts: z.partialRecord(
    z.enum(['unknown', 'ui_scope_end_observed']),
    count,
  ),
});
const base = {
  schemaVersion: z.literal(2),
  sourceKind: z.literal('rendered_ui'),
  runId: string,
  callId: string,
  batchId: string,
  browserTabId: z.string(),
  objective: z.string(),
  status,
  budgetUsage: usage,
  truncation,
  reportScopeFacts: reportScope.optional(),
  reportRunScopeFacts: z
    .object({
      version: z.literal(1),
      runId: string,
      callCount: count,
      unavailableCallCount: count,
      search: reportScope,
      read: reportScope,
    })
    .optional(),
  contentProjection: z.literal('x_research_projection_v1').optional(),
  metadataOmissions: z.array(z.string()).optional(),
  contentMetadataOmissions: z.array(z.string()).optional(),
};
const canonicalSchema = z.discriminatedUnion('operation', [
  z.object({
    ...base,
    operation: z.literal('search'),
    queries: z.array(searchRow),
  }),
  z.object({
    ...base,
    operation: z.literal('read'),
    targets: z.array(readRow),
  }),
]);

/** Shared extraction: no binding, native capability, or snapshot enters the identity. */
export function publicXArticleEntryIdentity(
  article: Pick<XArticleFacts, 'entryIdentity'> & {
    entry: Pick<
      NonNullable<XArticleFacts['entry']>,
      'observationId' | 'parentPostId' | 'sourceUrl' | 'targetUrl'
    > | null;
  },
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
/** Full allowlisted public DTO. This parsing grants no live browser authority. */
export function parseXResearchCanonical(raw: unknown): XResearchResult {
  return canonicalSchema.parse(raw);
}
export function canonicalizeXResearchResult(
  result: XResearchResult,
): XResearchResult {
  return parseXResearchCanonical(projectActionDiagnostics(result));
}
