# Baidu search card

> Probed with KyDog's real IAB on 2026-09-25. **Result extraction remains unverified; do not enable it by default.** This describes the tested network exit; trust the current IAB result on each run.

## Actions actually observed

- `browser_open({url:"https://www.baidu.com/"})` reached the homepage with HTTP 200. The visible input was `textarea#chat-textarea`; the submit button was `button#chat-submit-button`.
- `browser_act` entered the Chinese query and clicked submit. Navigation eventually reached `wappass.baidu.com/static/captcha/tuxing_v2.html`, titled `百度安全验证`, with no organic rows to extract.
- A separate `browser_open` to `https://www.baidu.com/s?wd=TypeScript%206.0%20release%20notes` also landed on Baidu's security challenge. A direct URL did not bypass it on this exit.

## Current handling

No result row, title, snippet, or `@href` selector was verified, nor requery or pagination. On `wappass.baidu.com` or `百度安全验证`, record the current `(engineId, query, attemptId)` as blocked by a challenge. Do not call it zero results or fetch the challenge page as target content. After the challenge is completed or the network exit changes, reverify result extraction through KyDog IAB before marking Baidu supported.
