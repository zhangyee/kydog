# AGRIS (FAO) · operations card

The UN Food and Agriculture Organization's global agricultural literature system.
**What it yields is bibliographic records, not full text.**
Axis-A kind 2. Shared discipline is in `SKILL.md` §5 and §6.

> **Reconnaissance: measured 2026-09-16 inside KyDog's own IAB** (it sits behind Cloudflare and
> nothing else gets in); every selector carries a hit count. Anything not measured says
> "not explored".

## ① Reachability

curl **403 Cloudflare**; **KyDog's IAB gets through**.

## ② What controls the page has

| Control | Selector | Measured |
| --- | --- | --- |
| Search box | `#query` | **1/1** |
| Submit button | `form:has(#query) button[type="submit"]` | **1** |

**Enter does not submit** (measured: no change); you must click the submit button.

## ③ Action · search

Results page `agris.fao.org/search/en?query=<query>`, **10 per page**.

| Field | Selector | Hits |
| --- | --- | --- |
| Item container | **`div.col-md-12:has(a[data-agris-title])`** | **10/10** |
| Title | `a[data-agris-title]` | **10/10** |
| Detail page | the same `@href` → `/search/en/records/<id>` | 10/10 |
| Full-text status badge | `span.badge.bg-emergency` | 10/10 (**not clickable**, see ⑥) |

Paging:

```jsonc
browser_act({ tabId: "<the same tabId>", actions: [
  { "kind": "click", "selector": "a.page-link[aria-label='Next']" },
  { "kind": "wait",  "until": { "urlMatches": "page=1" } },
  { "kind": "extract", "selectors": { "item": "div.col-md-12:has(a[data-agris-title])",
      "title": "a[data-agris-title]", "page": "a[data-agris-title]@href" }}
]})
```

`a.page-link[aria-label='Next']` matches **1/1**, and the address changes after paging.

> ⚠ **The container must be tightened with `:has()`.** A bare `div.col-md-12` matches **12**
> while titles match only **10** — the extra two are not results. Without tightening you extract
> two empty rows, and nothing reports it.

## ④ Action · getting access

Public, no login. Cloudflare is anti-bot defence, not an access right.

## ⑤ Action · detail page

Clicking the title gives **same-tab in-site navigation** to
`agris.fao.org/search/en/records/<id>`.

## ⑥ Action · getting the full text

**This source gives you no full text.**

The "Full text" on a result card is only a **status badge** (`span.badge.bg-emergency` 10/10,
measured `fullTextBadgeIsAction: false`, **not clickable**), and the sampled detail page had no
PDF entry either (**0/0**).

**Getting no full text is normal here, not a missed extraction.** Report the bibliographic record
and the DOI — anything pointing at arXiv / PMC / DOI goes to `fastpaper download`, and
**this source itself offers no address you could hand to `browser_download`**.

## ⑦ When you must hand over to a human

When Cloudflare appears — `ask_user_question` with `browserTabId`, one click is enough.

## ⑧ Known limits

- No public search API (both the site and its endpoints sit behind Cloudflare)
- **Only workable inside KyDog's IAB**
- **No full text**, only bibliographic records
- Authors / year / source fields were **not measured separately** this round
