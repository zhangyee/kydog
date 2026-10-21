# Baidu Search Operation Card

## Verified search path

Prefer the current home-page form pair `textarea#chat-textarea` and `button#chat-submit-button`. Use the classic pair `input#kw` and `input#su` only when the snapshot shows that both are visible. Never mix controls from the two forms.

Open the home page with `browser_open({"url":"https://www.baidu.com/"})`, keep the returned `tabId`, then type, submit, wait for organic results, and extract in one call:

```json
{"tabId":"<baiduTabId>","actions":[{"kind":"type","selector":"textarea#chat-textarea","text":"<query>"},{"kind":"click","selector":"button#chat-submit-button"},{"kind":"wait","until":{"selector":"#content_left .c-container:not(.EC_result)"},"timeoutMs":10000},{"kind":"extract","selectors":{"item":"#content_left .c-container:not(.EC_result)","title":"h3 a","url":"h3 a@href"}}],"research":{"engineId":"baidu","query":"<query>","angleIds":["<angleId>"],"executionPath":"homepage_form","submitActionIndex":1}}
```

For the classic form, replace only the first two selectors. Keep the wait, extraction, and `research` metadata unchanged. `.EC_result` is the structural marker for ad cards; do not infer ads from position or title.

## Requery and failure criteria

- There is no verified results-page requery path. For a new query, reuse the tab but return to the home page, determine which complete form pair is visible, and run the complete call again.
- Do not press Enter or construct a search URL. After an address change, still wait for the organic-result container. A changing AI summary, blank body, or old results do not prove success.
- Action failures before submit, in the post-submit wait, and during extraction automatically save `submission_error`, `navigation_error`, and `extraction_error`, respectively. Do not add diagnostic columns or a second call to guess the cause.
- If the tab reaches `wappass.baidu.com` or a human-operable challenge, call `ask_user_question` once with the current `browserTabId`. Save `blocked` only if the user skips, recovery fails, or no operable control exists.

## Criteria and boundaries

- `h3 a@href` may return `www.baidu.com/link?url=...`. Before first submitting the observation, call `browser_open({"researchResolveBatch":{"selections":[{"observationId":"<id>","resultIndexes":[0,3,7]}]}})` once for the shortlist. Submit only indexes reported as confirmed. Do not copy or decode redirect parameters.
- When the batch resolver returns `timeout`, that index remains unresolved; it does not prove that the target does not exist. Exclude and retain only that lead. A timed-out index must not be submitted, and a few timeouts do not justify replaying the whole batch.
- Submit only selected, confirmed redirect results. Explicit no-results pages and pagination have no verified path. Search snippets are discovery leads, not body evidence.
