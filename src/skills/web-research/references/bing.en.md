# Bing search card

> Probed on 2026-09-25 and 26 with KyDog's real IAB `browser_open` and `browser_act`. The Chinese query yielded 10 rows on the tested network exit. An English requery reached a challenge, so requery extraction is unverified. Trust the current IAB result on each run.

## Verified results page path

1. `browser_open({url:"https://www.bing.com/"})` reached the homepage with HTTP 200. Its input was `textarea#sb_form_q`, but typing and clicking `label#search_icon` stayed on the homepage and the search URL `wait` timed out. **Do not rely on this homepage submission path.**
2. For a known query, call `browser_open({tabId,url:"https://www.bing.com/search?q="+encodeURIComponent(query)})` in the same IAB tab. `TypeScript 6.0 新特性` reached an HTTP 200 results page. Check the snapshot for organic results; HTTP 200 or `q=` in the URL alone is insufficient.
3. On the results page, call `browser_act({tabId,actions:[{kind:"extract",selectors:{item:"li.b_algo",title:"h2 a",url:"h2 a@href",snippet:".b_caption p"}}]})`. This Chinese page yielded 10 rows. Some fields can be `null`; check each title and URL, and allow a missing snippet.

## Requery and failure checks

The results page uses `input#sb_form_q` and submit button `input#sb_form_go`. The first probe used `type` for `TypeScript 6.0 release notes` and `click` to submit; the URL and title changed, but `wait` for `li.b_algo h2 a` timed out. A second probe used `browser_open` in the same tab for the English search URL. Its snapshot explicitly said “One last step—please solve the challenge to continue,” and `extract` returned zero rows. Mark that attempt `blocked`; do not reuse the old query's 10 rows or interpret the challenge as zero search results. Inspect the current snapshot when a challenge or page structure change occurs.

## URLs and evidence boundary

Extracted `@href` values looked like `https://www.bing.com/ck/a?...` redirect links. Preserve the raw href and discovery context; let WebFetch follow each hop and record the final URL. Do not guess or manually decode the `u` parameter. Search snippets are discovery observations, not body evidence. Explicit zero-result pages and pagination remain unverified.
