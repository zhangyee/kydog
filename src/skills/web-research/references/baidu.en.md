# Baidu search card

> On 2026-09-26, the user's open Chrome browser reached results pages and verified extraction selectors and requery. On 2026-09-25, KyDog IAB reached a security challenge for comparable searches. **Success in Chrome does not establish success in KyDog IAB.** Trust the current IAB response; Baidu is not in the default engine set yet.

## Results-page structure observed in Chrome

- Opening `https://www.baidu.com/s?wd=` plus `encodeURIComponent(query)` directly returned organic results for a Chinese query. The results-page input was `textarea#chat-textarea` and its submit button was `button#chat-submit-button`. Entering `TypeScript 6.0 破坏性变更 官方` and clicking submit navigated to the new query's results page.
- Organic result cards were `#content_left .result.c-container[mu]`; within each, `h3` held the title and `.cos-line-clamp-2, .click-area-exp-block` the snippet. `h3 a@href` was a `www.baidu.com/link?url=…` redirect. The card's own `mu` attribute held the target URL. `result-op` AI and related cards were outside this organic set.
- If the **current KyDog IAB** really reaches a results page, try:

```json
{"item":"#content_left .result.c-container[mu]","title":"h3","url":":scope@mu","snippet":".cos-line-clamp-2, .click-area-exp-block"}
```

In `browser_act extract`, `:scope@mu` reads the **current item's own** `mu` attribute rather than a descendant. Check each URL is a target site matching its title. If `mu` is missing or the page changes, inspect the current page; do not guess the target from Baidu's redirect parameters. Snippets guide subsequent fetching but are not evidence from the target body.

## Block observed in KyDog IAB

- On 2026-09-25, `browser_open({url:"https://www.baidu.com/"})` reached the homepage with HTTP 200. After `browser_act` entered a Chinese query and clicked submit, navigation reached `wappass.baidu.com/static/captcha/tuxing_v2.html`, titled `百度安全验证`.
- A direct `browser_open` to an English search URL also reached the challenge. That IAB probe **did not** verify result extraction or requery.

If the current IAB still shows `wappass.baidu.com` or `百度安全验证`, record `(engineId, query, attemptId)` as `blocked`. Do not report zero results or send the challenge page to WebFetch. Record discoveries only when the current IAB displays organic results and successfully extracts their titles and target URLs.
