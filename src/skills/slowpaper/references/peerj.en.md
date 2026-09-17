# PeerJ · operations card

An OA journal for life sciences and computer science, with open review. Axis-A kind 2.
Shared discipline is in `SKILL.md` §5 and §6.

> **Reconnaissance: measured 2026-09-16 inside KyDog's own IAB** (it sits behind Cloudflare and
> nothing else gets in); every selector carries a hit count. Anything not measured says
> "not explored".

## ① Reachability

curl **403 Cloudflare**; an external automated browser gets in once and is blocked on revisit;
**KyDog's IAB gets through**.

When "verify you are human" appears, hand it to the user for one click; the cookie lands in the
persistent partition and is reused afterwards.

## ② What controls the page has

| Control | Selector | Measured |
| --- | --- | --- |
| Search box | `#searchTerm` | **1/1** |
| Submit button | — | **0 matches — this source has no submit button** |

**Enter is the only way to submit, and it works.** That is the opposite of Scholar / Baidu Xueshu
/ ChemRxiv / AGRIS — do not carry "always click the button" over as a general rule here, because
there is no button to click.

## ③ Action · search

Results page `peerj.com/articles/?q=<query>&type=articles`, **15 per page**.

| Field | Selector | Hits |
| --- | --- | --- |
| Item container | `div.row.mb-12.main-search-item-row` | 15 |
| Title | `div.text-h6 a[href^="/articles/"]` | 15/15 |
| Detail page | the same `@href`, shaped like `peerj.com/articles/21732` | 15/15 |

Paging:

```jsonc
browser_act({ tabId: "<the same tabId>", actions: [
  { "kind": "click", "selector": "button[aria-label='Next page']" },
  { "kind": "wait",  "until": { "urlMatches": "page=2" } },
  { "kind": "extract", "selectors": { "item": "div.row.mb-12.main-search-item-row",
      "title": "div.text-h6 a[href^=\"/articles/\"]", "page": "div.text-h6 a[href^=\"/articles/\"]@href" }}
]})
```

The paging control `button[aria-label='Next page']` matches **1/1** and **is a `button`, not a
link** — so it gets none of the navigation guarantee plain links carry, and the `wait` above is
required.

## ④ Action · getting access

Public, no login. Cloudflare is anti-bot defence, not an access right.

## ⑤ Action · detail page

Clicking the title → **same-tab in-site navigation** → `peerj.com/articles/<id>/`.

## ⑥ Action · getting the full text

| Entry | Selector | Hits |
| --- | --- | --- |
| **PDF** | `a.btn.btn-primary.js-download-btn[href$='.pdf']` | **1/1** |

Shaped like `peerj.com/articles/21696.pdf`; fetch it with `browser_download` (it goes through this tab's session).

## ⑦ When you must hand over to a human

When Cloudflare's "verify you are human" appears — `ask_user_question` with `browserTabId`, one
click is enough. **Do not reload repeatedly to wait it out.**

## ⑧ Known limits

- No public search API
- **Only workable inside KyDog's IAB** — external browsers cannot clear Cloudflare, so do not
  suggest the user try elsewhere
- No submit button; Enter is the only path
