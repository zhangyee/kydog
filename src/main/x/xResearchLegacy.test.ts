import { expect, it } from 'vitest';
import { projectLegacyXResult } from './xResearchLegacy';
const post = {
  id: '123',
  url: 'https://x.com/alice/status/123',
  author: { handle: 'alice' },
  text: 'parent',
  articlePreview: { title: 'preview' },
  metrics: {},
  media: [],
  links: [],
};
const item = {
  postId: '123',
  root: post,
  replies: [],
  coverage: {
    replyCursorExhausted: true,
    truncated: false,
    reason: 'cursor_exhausted',
  },
  article: {
    status: 'present',
    title: 'Title',
    plainText: 'attached body',
    blocks: [
      { key: 'k', type: 'paragraph', text: 'attached body', entities: [] },
    ],
  },
  articleReadAttempted: true,
  errors: [
    {
      kind: 'action_failed',
      operation: 'TweetDetail',
      navigation: { navigationId: 'nav-real', outcome: 'blocked' },
    },
  ],
};
const batch = {
  schemaVersion: 1,
  operation: 'read',
  status: 'partial',
  browserTabId: 'old-tab',
  objective: 'old',
  errors: [],
  items: [item],
};
it('legacyProjectionNeverReplaysOrUpgradesSource: whitelist retains direct association and explicit unknown provenance', () => {
  const result = projectLegacyXResult({
    ...batch,
    cursor: 'secret',
    capture: { payload: 'secret' },
  });
  expect(result).toMatchObject({
    sourceKind: 'legacy_x_graphql',
    posts: [
      {
        postId: '123',
        sourceUrl: post.url,
        authorHandle: 'alice',
        text: 'parent',
      },
    ],
    articles: [
      {
        parent: { postId: '123', sourceUrl: post.url, authorHandle: 'alice' },
        plainText: 'attached body',
        independentIdentity: null,
      },
    ],
    parentNavigations: [
      {
        postId: '123',
        attempted: true,
        navigationId: 'nav-real',
        outcome: 'blocked',
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(result.posts[0]).toMatchObject({
    observationId: null,
    observedAt: null,
    runId: null,
    batchId: null,
  });
  const missing = projectLegacyXResult({
    ...batch,
    items: [{ ...item, root: undefined }],
  });
  expect(missing.articles).toEqual([]);
  expect(missing.posts).toEqual([]);
  expect(
    projectLegacyXResult({
      ...batch,
      items: [
        { ...item, root: { ...post, author: { handle: 'WrongAuthor' } } },
      ],
    }).articles,
  ).toEqual([]);
});
