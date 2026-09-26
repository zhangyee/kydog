# Google search card

> On 2026-09-26, the user's open Chrome browser reached results pages and verified extraction selectors and requery. On 2026-09-25, KyDog IAB reached a challenge page for comparable searches. **Success in Chrome does not establish success in KyDog IAB.** Trust the current IAB response; Google is not in the default engine set yet.

## Results-page structure observed in Chrome

- Opening `https://www.google.com/search?q=` plus `encodeURIComponent(query)` directly returned organic results for `TypeScript 6.0 release notes`. The results-page search box was `textarea[name=q]`. Replacing its text with `TypeScript 6.0 breaking changes official` and pressing Enter navigated to a new results page with changed results and snippets.
- Organic result containers were `div.N54PNb`; within each, `h3` held the title, `a:has(h3)@href` the target URL, and `div.VwiC3b` the snippet. The second query returned the official TypeScript documentation among other results. The page also had an AI block; do not mix its headings into organic results.
- If the **current KyDog IAB** really reaches a results page, try:

```json
{"item":"div.N54PNb","title":"h3","url":"a:has(h3)@href","snippet":"div.VwiC3b"}
```

Check that the current query, titles, and URLs align after extraction. Snippets guide discovery; they do not replace fetching target content. Page structure can change, so these are candidate selectors rather than an IAB guarantee.

## Block observed in KyDog IAB

- On 2026-09-25, `browser_open({url:"https://www.google.com/"})` reached the homepage with HTTP 200. After `browser_act` typed a Chinese query into `textarea[name=q]` and pressed Enter, navigation reached `www.google.com/sorry/index?continue=…`; the tool reported HTTP 429 and a `presentation "reCAPTCHA"` snapshot.
- A direct `browser_open` to an English search URL also reached `sorry/index`. That IAB probe **did not** verify result extraction or requery.

If the current IAB still shows `sorry/index`, HTTP 429, or reCAPTCHA, record `(engineId, query, attemptId)` as `blocked`. Do not report zero results or send the challenge page to WebFetch. Record discoveries only when the current IAB displays organic results and successfully extracts their titles and target URLs.
