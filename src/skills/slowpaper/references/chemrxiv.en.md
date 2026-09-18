# ChemRxiv · operations card

A chemistry preprint server. Axis-A kind 2. Shared discipline is in `SKILL.md` §5 and §6.

> **Reconnaissance: measured 2026-09-16 inside KyDog's own IAB** (it sits behind Cloudflare and
> nothing else gets in); every selector carries a hit count. Anything not measured says
> "not explored".

## ① Reachability

curl **403 Cloudflare**, and **its public-api is 403 too** — so even the API route is closed.
KyDog's IAB gets through, but **this round still needed one human click** before the e2e run saw
the real DOM.

> ⚠ **This source has a hard rule: never open a result deep link directly.**
> Measured: searching interactively from the home page reaches the results page, while opening
> `chemrxiv.org/action/doSearch?...` directly **falls back into the Cloudflare loop**. There is
> only one entry: **home page → real search → results page**.

## ② What controls the page has

| Control | Selector | Measured |
| --- | --- | --- |
| Search box | `input[placeholder="Search for preprint research articles, keywords, etc."]` | **1** |
| Submit button | in-form `button[type="submit"]` | **1** |

**Enter does not submit** (measured: no change); you must click the submit button.

The results page carries an **osano cookie banner** (its "accept / deny" buttons are visible),
the same family as Frontiers' onetrust, and it will intercept clicks.

## ③ Action · search

```jsonc
browser_open({ url: "https://chemrxiv.org/" })
browser_act({ tabId: "<tabId from the previous step>", actions: [
  { "kind": "type",  "selector": "input[placeholder=\"Search for preprint research articles, keywords, etc.\"]", "text": "<query>" },
  { "kind": "click", "selector": "form:has(input[placeholder=\"Search for preprint research articles, keywords, etc.\"]) button[type=\"submit\"]" },
  { "kind": "wait",  "until": { "selector": "div.auth-xslt-item", "state": "present" } },
  { "kind": "extract", "selectors": { "item": "div.auth-xslt-item",
      "title": "div.auth-xslt-item__title__wrapper span.hlFld-Title > a",
      "page": "div.auth-xslt-item__title__wrapper span.hlFld-Title > a@href" }}
]})
```

Results page `chemrxiv.org/action/doSearch?AllField=<query>`, **20 per page**.

| Field | Selector | Hits |
| --- | --- | --- |
| Item container | `div.auth-xslt-item` | **20/20** |
| Title / detail page | `div.auth-xslt-item__title__wrapper span.hlFld-Title > a[href*='/doi/full/']` | **20/20** |
| Date | `div.auth-xslt-item__date` | captured |

Paging: the real "next" href contains `startPage=1`, so the wait condition is
`urlMatches: "startPage=1"`.

## ④ Action · getting access

Public, no login. Cloudflare is anti-bot defence, not an access right.

## ⑤ Action · detail page

The title is itself an `<a href>`; clicking it gives **same-tab in-site navigation** to
`chemrxiv.org/doi/full/10.26434/chemrxiv-<id>`.

## ⑥ Action · getting the full text

| Entry | Selector | Hits |
| --- | --- | --- |
| View PDF | `a.btn.btn--pdf[href*='/doi/pdf/']` | **2/2** (the UI appears twice) |
| Download PDF | `a#downloadPdfUrl[href*='/doi/pdf/']` | **1/1** |
| Supplementary | `a[download][href$='.pdf']` | **1/1** |

> ⚠ **The site's own download link is malformed**: the measured sample is
> `…/doi/pdf/10.26434/chemrxiv-2023-bt10w?download=true?redirectToLatest=false` — **two `?`**.
> **Pass it to `browser_download` verbatim; do not "fix" it into `&`** — that is a guess, and a
> wrong one fetches nothing.

## ⑦ When you must hand over to a human

When Cloudflare appears (**normal here — the first visit almost always hits it**) —
`ask_user_question` with `browserTabId`. Same when the cookie banner blocks an action.

## ⑧ Known limits

- No usable API (the public-api is behind Cloudflare too)
- **Only workable inside KyDog's IAB**, and **only by searching from the home page**
- The results page carries a cookie banner that may intercept clicks
