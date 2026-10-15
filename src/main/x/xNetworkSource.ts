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
    if (r.quoted_status_result || r.article) {
      unsupported('tweet_embedded_shape');
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
      for (const child of c.items) item(child.item?.itemContent);
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
