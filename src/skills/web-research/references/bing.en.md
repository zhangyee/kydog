# Bing Search Operation Card

## Verified search path

Bing uses its search URL directly; opening the home page first is unnecessary. Omit `tabId` for the first query and reuse the returned tab for later queries:

```json
{"url":"https://www.bing.com/search?q=<encodeURIComponent(query)>","research":{"engineId":"bing","query":"<query>","angleIds":["<angleId>"],"executionPath":"search_url"}}
```

After navigation succeeds, extract on the same tab with the identical query:

```json
{"tabId":"<bingTabId>","actions":[{"kind":"extract","selectors":{"item":"li.b_algo","title":"h2 a","url":"h2 a@href","snippet":".b_caption p"}}],"research":{"engineId":"bing","query":"<query>","angleIds":["<angleId>"],"executionPath":"search_url"}}
```

Keep the returned `observationId`. HTTP 200 or `q=` in the URL does not replace extraction.

## Requery and failure criteria

- For a new query, call `browser_open` on the same `bingTabId` with a search URL and exactly matching `research`, then extract on that same tab.
- A Bing `/ck/a` URL is not a target URL. First shortlist results by title and snippet. Before the observation's first submit, call `browser_open({"researchResolveBatch":{"selections":[{"observationId":"<id>","resultIndexes":[0,3,7]}]}})` once to resolve the batch. The tool navigates a small number of IAB tabs concurrently and saves each final address only after the main frame leaves the Bing domain.
- A `timeout` in the batch result only means no departure from Bing was observed before the deadline. It does not prove the target site is unreachable and does not permit copying or decoding redirect parameters. Submit only indexes reported as confirmed.
- A failed search-URL navigation is `navigation_error`; a failed extraction is automatically saved as `extraction_error`. Save a challenge through `status_only` with its actual state. Never record old-query results or a challenge as zero results.

## Criteria and boundaries

- The first `submit` selects only confirmed results. An unconfirmed `/ck/a` remains a lead, appears in `unresolvedIndexes`, does not enter body fetching, and is not a fetch failure.
- Search snippets are discovery leads, not body evidence. Explicit no-results pages and pagination have no verified operation path.
