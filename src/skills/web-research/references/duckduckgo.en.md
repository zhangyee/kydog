# DuckDuckGo search card

> Verified end to end on 2026-09-25 with KyDog's real IAB `browser_open` and `browser_act`. The tested network exit yielded 10 rows for each of a Chinese and an English query. Trust the current tool result on every run.

## Verified search path

1. `browser_open({url:"https://duckduckgo.com/"})` returned HTTP 200. Keep its `tabId` for all following actions.
2. `browser_act({tabId,actions:[{kind:"type",selector:"textarea[name=q]",text:query},{kind:"key",key:"Enter"},{kind:"wait",until:{urlMatches:"q="},timeoutMs:8000}]})` navigated to `duckduckgo.com/?…&q=…` with HTTP 200 for the Chinese query. `urlMatches` confirms navigation only; inspect the landed page for results.
3. On the results page, use `browser_act({tabId,actions:[{kind:"extract",selectors:{item:"article[data-testid=result]",title:"a[data-testid=result-title-a]",url:"a[data-testid=result-title-a]@href",snippet:"[data-result=snippet]"}}]})`. It returned 10 organic rows with a title, target URL, and snippet. Snippets are discovery observations, not verified page evidence.
4. To change the query on the same results page, `type` into `input#search_form_input`, use `key Enter`, `wait` for a distinctive part of the new query in the URL, and run the same `extract` again. `TypeScript 6.0 release notes` returned 10 different rows in this probe.

## Checks and limits

- Homepage HTTP 200, action `status:ok`, or `q=` in the URL alone does not prove search success. Require a results page for the current query and extracted `title` and `url` values. Treat an empty extraction as no usable result obtained; inspect the snapshot before calling it an explicit zero-result page.
- Challenge pages, explicit zero-result pages, pagination, and direct search URLs were not verified. On a challenge, changed page structure, or timeout, record this attempt's observed failure and use the actual snapshot to decide whether to retry. Do not invent selectors.
- Extracted URLs are fetch candidates. Read known target URLs through the separate WebFetch path rather than treating search interactions as page fetching.
