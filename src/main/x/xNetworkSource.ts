import { isXPostId, isXHandle } from './xResearchIdentity';
import { randomUUID } from 'node:crypto';
import type { XSearchQuery, XTextObservation } from './xResearchTypes';

/** Public source coordinates. Raw URLs, variables and cursor tokens stay private. */
export interface XNetworkProvenance {
  leaseId: string;
  requestRef: string;
  navigationId: string;
  documentEpoch: number;
  routeRevision: number;
  navigationSequence: number;
  operation: string;
  observedAt: string;
}
export interface XNetworkPage {
  provenance: XNetworkProvenance;
  inputCursor: string | null;
  outputCursor: string | null;
  end: 'unknown' | 'cursor_exhausted';
  posts: XTextObservation[];
  quotedPosts: XTextObservation[];
  unsupported: string[];
}
export interface XSearchNetworkRequest {
  provenance: XNetworkProvenance;
  query: XSearchQuery;
  inputCursor: string | null;
}
const object = (v: unknown): Record<string, any> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, any>)
    : {};
/** Only paths demonstrated by the recorded search fixtures. No recursive tweet hunting. */
export function decodeXSearchResponse(
  body: unknown,
  request: XSearchNetworkRequest,
): XNetworkPage {
  const page: XNetworkPage = {
    provenance: { ...request.provenance },
    inputCursor: request.inputCursor,
    outputCursor: null,
    end: 'unknown',
    posts: [],
    quotedPosts: [],
    unsupported: [],
  };
  const unsupported = (reason: string) => {
    if (!page.unsupported.includes(reason)) page.unsupported.push(reason);
  };
  const root = object(body);
  if (root.errors) {
    unsupported('graphql_errors');
    return page;
  }
  const instructions =
    root.data?.search_by_raw_query?.search_timeline?.timeline?.instructions;
  if (!Array.isArray(instructions)) {
    unsupported('search_timeline_missing');
    return page;
  }
  const tweet = (raw: unknown) => {
    const r = object(raw),
      user = r.core?.user_results?.result,
      legacy = r.legacy;
    if (
      r.__typename !== 'Tweet' ||
      !isXPostId(r.rest_id) ||
      legacy?.id_str !== r.rest_id ||
      user?.__typename !== 'User' ||
      !isXHandle(user.core?.screen_name) ||
      typeof legacy?.full_text !== 'string'
    ) {
      unsupported('tweet_shape');
      return;
    }
    // A quoted post or an Article preview is nested content this tier never
    // recurses into; it is not an unreadable shape. The Tweet itself is fully
    // decoded below, and an Article's missing body is already carried per-post
    // by articlePreviewInventory. Marking the whole response unsupported here
    // discarded every proven entry and aborted the query chain.
    let text = legacy.full_text;
    if (r.note_tweet) {
      const note = r.note_tweet?.note_tweet_results?.result?.text;
      if (typeof note !== 'string') {
        unsupported('note_shape');
        return;
      }
      text = note;
    }
    const handle = user.core.screen_name;
    page.posts.push({
      observationId: randomUUID(),
      sourceKind: 'page_graphql',
      networkProvenance: { ...request.provenance },
      postId: r.rest_id,
      containerKind: 'root_post',
      sourceUrl: `https://x.com/${handle}/status/${r.rest_id}`,
      author: {
        handle,
        displayName: typeof user.core.name === 'string' ? user.core.name : null,
        profileUrl: `https://x.com/${handle}`,
      },
      ...(r.article
        ? {
            articlePreviewInventory: {
              scope: 'collection' as const,
              observed: 0,
              retained: 0,
              omitted: 0,
              unresolved: 1,
            },
          }
        : {}),
      text,
      observedAt: request.provenance.observedAt,
      truncation: {
        returned: text.length,
        totalKnown: text.length,
        truncated: false,
      },
    });
  };
  const item = (raw: unknown) => {
    const i = object(raw);
    if (i.itemType === 'TimelinePrompt') return;
    if (i.itemType !== 'TimelineTweet') {
      unsupported('item_shape');
      return;
    }
    tweet(i.tweet_results?.result);
  };
  const entry = (raw: unknown) => {
    const c = object(object(raw).content);
    if (c.entryType === 'TimelineTimelineCursor') {
      if (
        !['Top', 'Bottom'].includes(c.cursorType) ||
        typeof c.value !== 'string' ||
        !c.value
      ) {
        unsupported('cursor_shape');
        return;
      }
      if (c.cursorType === 'Bottom') {
        if (page.outputCursor !== null && page.outputCursor !== c.value)
          unsupported('ambiguous_bottom_cursor');
        else page.outputCursor = c.value;
      }
    } else if (c.entryType === 'TimelineTimelineItem') item(c.itemContent);
    else if (
      c.entryType === 'TimelineTimelineModule' &&
      c.displayType === 'VerticalConversation' &&
      Array.isArray(c.items)
    )
      for (const child of c.items) item(object(child).item?.itemContent);
    else unsupported('entry_shape');
  };
  for (const instruction of instructions) {
    const i = object(instruction);
    if (i.type === 'TimelineAddEntries' && Array.isArray(i.entries))
      i.entries.forEach(entry);
    else if (
      i.type === 'TimelineReplaceEntry' &&
      ['cursor-top-9223372036854775807', 'cursor-bottom-0'].includes(
        i.entry_id_to_replace,
      )
    )
      entry(i.entry);
    else if (i.type === 'TimelineTerminateTimeline') {
      if (i.direction === 'Bottom') page.end = 'cursor_exhausted';
      else unsupported('termination_direction');
    } else unsupported('instruction_shape');
  }
  if (page.outputCursor === null && page.end === 'unknown')
    unsupported('missing_pagination');
  if (page.unsupported.length) page.end = 'unknown';
  return page;
}

export interface XReadNetworkRequest {
  provenance: XNetworkProvenance;
  postId: string;
  inputCursor: string | null;
  branchKey: string | null;
  sortKey: string | null;
  collectReplies: boolean;
}
export interface XNetworkReadPage extends XNetworkPage {
  root: XTextObservation | null;
  replies: XTextObservation[];
  unscopedPosts: import('./xResearchTypes').XUnscopedPost[];
  branchKey: string | null;
  sortKey: string | null;
  /** Private source ownership/order used before retention sampling. */
  quoteParents?: Record<string, string>;
  sampleOrder?: string[];
  /** Exact source labels, not completeness or DOM action permissions. */
  continuationKind: 'Bottom' | 'ShowMoreThreads' | null;
  terminationDirections: ('Top' | 'Bottom')[];
}
/** TweetDetail shapes are supported only by the independently recorded read corpus. */
export function decodeXReadResponse(
  body: unknown,
  request: XReadNetworkRequest,
): XNetworkReadPage {
  const page: XNetworkReadPage = {
    provenance: { ...request.provenance },
    inputCursor: request.inputCursor,
    outputCursor: null,
    end: 'unknown',
    posts: [],
    quotedPosts: [],
    unsupported: [],
    root: null,
    replies: [],
    unscopedPosts: [],
    branchKey: request.branchKey,
    sortKey: request.sortKey,
    continuationKind: null,
    terminationDirections: [],
    quoteParents: {},
    sampleOrder: [],
  };
  const unsupported = (reason: string) => {
    if (!page.unsupported.includes(reason)) page.unsupported.push(reason);
  };
  const root = object(body);
  if (root.errors) {
    unsupported('graphql_errors');
    return page;
  }
  const instructions =
    root.data?.threaded_conversation_with_injections_v2?.instructions;
  if (!Array.isArray(instructions)) {
    unsupported('read_timeline_missing');
    return page;
  }
  const tweet = (raw: unknown, quoted = false, parentId?: string): void => {
    let r = object(raw);
    const wrapped = r.__typename === 'TweetWithVisibilityResults';
    if (wrapped) r = object(r.tweet);
    const legacy = object(r.legacy),
      user = r.core?.user_results?.result;
    if (
      (r.__typename !== 'Tweet' &&
        !(wrapped && !Object.hasOwn(r, '__typename'))) ||
      !isXPostId(r.rest_id) ||
      legacy.id_str !== r.rest_id ||
      user?.__typename !== 'User' ||
      !isXHandle(user.core?.screen_name)
    ) {
      unsupported('tweet_identity_shape');
      return;
    }
    const isRoot = !quoted && r.rest_id === request.postId;
    // Check domain before any ordinary reply/quote/note text access.
    if (!isRoot && !request.collectReplies && !quoted) return;
    if (typeof legacy.full_text !== 'string') {
      unsupported('tweet_text_shape');
      return;
    }
    let text = legacy.full_text;
    if (r.note_tweet) {
      const note = r.note_tweet?.note_tweet_results?.result?.text;
      if (typeof note !== 'string') {
        unsupported('note_shape');
        return;
      }
      text = note;
    }
    const handle = user.core.screen_name;
    const base = {
      observationId: randomUUID(),
      sourceKind: 'page_graphql' as const,
      networkProvenance: { ...request.provenance },
      postId: r.rest_id,
      sourceUrl: `https://x.com/${handle}/status/${r.rest_id}`,
      author: {
        handle,
        displayName: typeof user.core.name === 'string' ? user.core.name : null,
        profileUrl: `https://x.com/${handle}`,
      },
      text,
      observedAt: request.provenance.observedAt,
      truncation: {
        returned: text.length,
        totalKnown: text.length,
        truncated: false,
      },
      ...(r.article
        ? {
            articlePreviewInventory: {
              scope: 'collection' as const,
              observed: 0,
              retained: 0,
              omitted: 0,
              unresolved: 1,
            },
          }
        : {}),
    };
    if (r.article && !isXPostId(r.article?.article_results?.result?.rest_id))
      unsupported('article_preview_shape');
    if (quoted) {
      page.quotedPosts.push({ ...base, containerKind: 'quoted_post' });
      page.quoteParents![base.observationId] = parentId!;
    } else if (isRoot) {
      const p: XTextObservation = { ...base, containerKind: 'root_post' };
      page.root = p;
      page.posts.push(p);
    } else if (
      isXPostId(legacy.in_reply_to_status_id_str) &&
      legacy.conversation_id_str === request.postId
    ) {
      const p: XTextObservation = {
        ...base,
        containerKind: 'reply',
        directParent: {
          postId: legacy.in_reply_to_status_id_str,
          sourceUrl: null,
        },
        conversationId: legacy.conversation_id_str,
      };
      page.replies.push(p);
      page.posts.push(p);
    } else
      page.unscopedPosts.push({
        ...base,
        containerKind: 'unscoped_post',
        relationToTarget: 'unproven',
        observedContainer: 'post',
      });
    if (!quoted && !isRoot) page.sampleOrder!.push(base.observationId);
    if (r.quoted_status_result && !quoted)
      tweet(r.quoted_status_result.result, true, r.rest_id);
  };
  const item = (raw: unknown) => {
    const i = object(raw);
    if (i.itemType === 'TimelineLabel') return;
    if (i.itemType !== 'TimelineTweet') {
      unsupported('item_shape');
      return;
    }
    tweet(i.tweet_results?.result);
  };
  for (const raw of instructions) {
    const i = object(raw);
    if (i.type === 'TimelineClearCache') continue;
    if (i.type === 'TimelineTerminateTimeline') {
      if (i.direction === 'Top' || i.direction === 'Bottom')
        page.terminationDirections.push(i.direction);
      else unsupported('termination_direction');
      continue;
    }
    if (i.type !== 'TimelineAddEntries' || !Array.isArray(i.entries)) {
      unsupported('instruction_shape');
      continue;
    }
    for (const rawEntry of i.entries) {
      const c = object(object(rawEntry).content);
      if (c.entryType === 'TimelineTimelineItem') item(c.itemContent);
      else if (
        c.entryType === 'TimelineTimelineModule' &&
        c.displayType === 'VerticalConversation' &&
        Array.isArray(c.items)
      )
        for (const child of c.items) item(object(child).item?.itemContent);
      else if (c.entryType === 'TimelineTimelineCursor') {
        if (
          !['Top', 'Bottom', 'ShowMoreThreads'].includes(c.cursorType) ||
          typeof c.value !== 'string' ||
          !c.value
        ) {
          unsupported('cursor_shape');
          continue;
        }
        if (c.cursorType !== 'Top') {
          if (page.outputCursor !== null && page.outputCursor !== c.value)
            unsupported('ambiguous_continuation');
          else {
            page.outputCursor = c.value;
            page.continuationKind = c.cursorType;
          }
        }
      } else unsupported('entry_shape');
    }
  }
  if (
    page.terminationDirections.includes('Bottom') &&
    page.branchKey !== null &&
    page.sortKey !== null
  )
    page.end = 'cursor_exhausted';
  if (
    page.outputCursor === null &&
    !page.terminationDirections.includes('Bottom')
  )
    unsupported('missing_pagination');
  if (page.unsupported.length) page.end = 'unknown';
  return page;
}
