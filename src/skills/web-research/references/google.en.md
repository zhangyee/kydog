# Google search card

> Probed with KyDog's real IAB on 2026-09-25. **Result extraction remains unverified; do not enable it by default.** This is an observation for the tested network exit, not a general availability claim; trust the current IAB result.

## Actions actually observed

- `browser_open({url:"https://www.google.com/"})` reached the homepage with HTTP 200. Its search box was `textarea[name=q]`.
- `browser_act` used `type` for the Chinese query and `key Enter`, then navigated to `www.google.com/sorry/index?continue=…`. The tool reported HTTP 429 and a `presentation "reCAPTCHA"` snapshot. Homepage reachability does not establish result reachability.
- `browser_open` for the English query at `https://www.google.com/search?q=TypeScript%206.0%20release%20notes` also landed on `sorry/index`. An intermediate search URL or HTTP 200 text does not establish a results page.

## Current handling

This probe verified no result row, title, snippet, or `@href` selector, nor a requery or pagination. When `sorry/index`, HTTP 429, or a reCAPTCHA snapshot appears, record the current `(engineId, query, attemptId)` as blocked by a challenge. Do not call it zero results or feed the challenge page to WebFetch as target content. After a user completes the challenge or the network exit changes, reverify result extraction through KyDog IAB before marking Google supported.
