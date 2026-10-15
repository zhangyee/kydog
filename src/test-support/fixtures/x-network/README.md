# Recorded X SearchTimeline fixtures

Captured 2026-10-15 via logged-in Chrome ordinary navigation and scrolling, with sanitized DevTools HAR export. Original local evidence lives in ignored `docs/superpowers/captures/2026-10-15-x-net-layer/`.

These are deidentified, field-projected real responses, not synthetic wire examples. Request headers, cookies, authentication, viewer relationships/preferences, analytics/controller data, media/card URLs, and all unrelated fields were discarded. Public IDs, author and text were consistently replaced; opaque cursors were mapped to local fixture tokens with equality preserved. No raw token mapping is committed. Entry order, container structure, instruction kinds and cursor directions are unchanged. Public input query was replaced consistently. JSON files contain only request variables needed to exercise matching and a projected response body. Test stress variants explicitly derive IDs from these shapes and do not count as captured evidence.

Supported recorded paths: `data.search_by_raw_query.search_timeline.timeline.instructions`; `TimelineAddEntries.entries`, `TimelineReplaceEntry.entry`, `TimelineTerminateTimeline.direction=Bottom`; item `content.itemContent.tweet_results.result`, conversation module `content.items[].item.itemContent.tweet_results.result`; Tweet `rest_id`, `legacy.id_str/full_text`, `core.user_results.result.core.name/screen_name`, and optional `note_tweet.note_tweet_results.result.text`. Cursor content has `entryType=TimelineTimelineCursor`, `cursorType=Top|Bottom`, `value`. Recorded TimelinePrompt is a non-post prompt. No quote, visibility wrapper or Article shape was recorded: they are unsupported, not inferred. Search paths are not evidence for read decoding.

Top and Latest next request cursor equals the preceding response Bottom cursor. The empty response includes a Bottom termination alongside Top and Bottom cursors. An older in-flight NASA Latest request in search-empty.har is excluded by exact query/product, not time. Count is a request value, never assumed page cardinality.

| Fixture | Local HAR / entry | Original bytes | Original SHA256 | Fixture SHA256 |
|---|---|---:|---|---|
| search-top-initial.json | search-top.har / 0 | 147693 | 34ae923362d7197dcdc7b430c98268832e583b748573a9571154b69e22208b04 | da834f13ef0293961bdeaadec3eb561aea79850a36e8a0a4652ffb73ab1f0089 |
| search-top-next.json | search-top.har / 1 | 147053 | 76406bae5645a205965791652be3399312579272f77706d5b6405a36e796463b | 44c8c22e9d2c7da9869f4a6d1f24944b90fce02489fb19ecdc74468d80dba539 |
| search-latest-initial.json | search-latest.har / 0 | 133655 | 3ac99fd3c2796b2304cd838acd96d6635094149a85886ba207ecad51b9d005eb | 06af3ba4dbe9ea21f00f0052ba252be0c4c3b0d75a2656762765cd0878b5ff34 |
| search-latest-next.json | search-latest.har / 1 | 134038 | 53405a451d336fcbd6b7e03c07c299fccf2696cb9f2adf37817f505843f07713 | 5592ab5f62776e1b1d5fa7c907e869e3e3f2673b35b7f910c589521f9e337c41 |
| search-empty-initial.json | search-empty.har / 1 | 768 | e6baa2cdd6a72af980c452b72c1d995cc72929297549de81d6d215a8ce0b47fd | 263562ad04a77c6e5e03ef18dc0e75e804483502abc1595492c40cbb5ba15ae5 |
