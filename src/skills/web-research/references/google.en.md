# Google Search Operation Card

## Verified search path

The home-page query field is `textarea[name="q"]`. The page has multiple submit controls with the same name. `div[jsname="VlcLAe"] input.gNO89b[name="btnK"]` is a hidden 0×0 duplicate and must not be used. After typing, the suggestion layer can also expose two nonzero “Google Search” buttons at once. Send Escape to the still-focused query field to close the suggestion layer, then use the action-time semantic locator for the one visible submit button.

```json
{"tabId":"<googleTabId>","actions":[{"kind":"type","selector":"textarea[name=\"q\"]","text":"<query>"},{"kind":"key","key":"Escape"},{"kind":"click","locator":{"role":"button","name":["Google 搜索","Google Search"],"visible":true}},{"kind":"wait","until":{"urlMatches":"/search?"},"timeoutMs":10000},{"kind":"extract","selectors":{"item":"a:has(h3)","title":"h3","url":":scope@href"}}],"research":{"engineId":"google","query":"<query>","angleIds":["<angleId>"],"executionPath":"homepage_form","submitActionIndex":2}}
```

Escape only closes the suggestion layer and is not the submit action, so `submitActionIndex` points to the zero-based action 2, the `click`. The locator uses exact names and requires one nonzero-size node. Zero or multiple matches fail instead of guessing by order or coordinates. If the page explicitly reports that the node went stale, lost its size, or became intercepted between locating and measuring, the tool obtains one new snapshot and resolves it once more. `div.MjjYud` is a result-layout container, not a stable result item. The final extraction uses the `a` that wraps `h3`.

## Requery and failure criteria

- For a new query, reuse the tab but return to `https://www.google.com/`, then run the same complete call. The semantic target is resolved when the click executes and never reuses an old snapshot index.
- Do not press Enter, construct a search URL, or fall back to the hidden-button CSS. Automatically saved `submission_error`, `navigation_error`, and `extraction_error` observations are the actual failure; do not append DOM-diagnostic calls.
- Close the suggestion layer with Escape before resolving the button; this avoids a multiple match when the suggestion-layer button and home-page button are both visible. If Escape still leaves zero or multiple matches and the call produces `submission_error`, the failure belongs only to the current query. Google remains available and must not be marked `blocked` or removed from later queries. Do not manually fetch a new button index or replay the original batch in the conversation.
- If reCAPTCHA or another human-operable challenge appears, call `ask_user_question` once with the current `browserTabId`, offering “Solved, continue” and “Skip Google.” Do not read, click, or open another tab while waiting.
- After confirmation, inspect the same tab first. Extract directly if it returned to results. Save `status_only`, `blocked` only if the user skips, recovery fails, or no operable control exists. Do not automatically hit the same challenge for later queries in this task.

## Criteria and boundaries

- HTTP 200 on the home page, a successful click, or a query in the URL does not independently prove organic results. A challenge is neither zero results nor an ordinary fetch target.
- `submission_error`, `navigation_error`, and `extraction_error` are query-attempt states, not engine states. Only an unrecovered challenge described above can make Google `blocked` for the run.
- The extraction saves title links and does not promise snippets. Use exact `resultIndexes` to exclude navigation, ads, and unrelated candidates.
- An extracted Google-owned `/goto` redirect remains an unconfirmed target. Shortlist intended indexes by title, then call `browser_open({"researchResolveBatch":{"selections":[{"observationId":"<id>","resultIndexes":[0,3,7]}]}})` once before the observation's first submit. Put only indexes reported as confirmed in `observationSelections`. The tool navigates a small batch of IAB tabs; it never copies or decodes redirect parameters.
- Action-time semantic location is the precise path for this dynamic button. Add a fixed CSS selector to this card only after a successful real-IAB call verifies it.
