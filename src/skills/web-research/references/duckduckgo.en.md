# DuckDuckGo Search Operation Card

## Verified search path

The home-page query field is `textarea[name="q"]`, and organic result items are `article[data-testid="result"]`. The home-page submit button is conditionally collapsed. In the real IAB page it can remain `0×32` after text was successfully inserted, so this path does not click that button. Once the field is focused and contains the query, submit the form with Enter.

Open the home page with `browser_open({"url":"https://duckduckgo.com/"})`, keep the returned `tabId`, then type, submit, wait, and extract in one call:

```json
{"tabId":"<ddgTabId>","actions":[{"kind":"type","selector":"textarea[name=\"q\"]","text":"<query>"},{"kind":"key","key":"Enter"},{"kind":"wait","until":{"selector":"article[data-testid=\"result\"]"},"timeoutMs":10000},{"kind":"extract","selectors":{"item":"article[data-testid=result]","title":"a[data-testid=result-title-a]","url":"a[data-testid=result-title-a]@href","snippet":"[data-result=snippet]"}}],"research":{"engineId":"duckduckgo","query":"<query>","angleIds":["<angleId>"],"executionPath":"homepage_form","submitActionIndex":1}}
```

`submitActionIndex` identifies the zero-based submit `key Enter`. This call returns the `observationId`; do not split out extra `browser_act` calls to diagnose the DOM.

## Requery and failure criteria

- For a new query, reuse the same tab but first return to the home page with `browser_open({"tabId":"<ddgTabId>","url":"https://duckduckgo.com/"})`, then repeat the complete call.
- Enter is this card's primary submit action, not a fallback after failure. Do not switch to the collapsed button or construct a search URL. A pre-submit failure is automatically saved as `submission_error`; an unmet post-submit result condition becomes `navigation_error`; a failed extract becomes `extraction_error`. Do not add a `status_only` call that merely copies the same failure.
- Save `executionPath:"status_only"`, `status:"explicit_empty"` only for an explicit no-results page. Save a challenge as `blocked`.

## Criteria and boundaries

- HTTP 200 on the home page, a completed submit action, or `q=` in the address does not independently prove that organic results were obtained. Require the result-container wait and extraction facts.
- Search snippets are discovery leads, not body evidence. Challenges, pagination, and explicit no-results pages have no additional verified operation path.
- An IAB observation discovers candidates. Send selected external direct links to background workers only through `observationSelections`.
