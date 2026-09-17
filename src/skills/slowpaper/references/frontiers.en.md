# Frontiers · operations card

A pure-OA publisher with 200+ journals. Axis-A kind 2. Shared discipline is in `SKILL.md` §5 and §6.

> **Reconnaissance: measured on the live site 2026-09-16** (viewport 1280); every selector
> carries a hit count. Anything not measured says "not explored".

## ① Reachability

**Keyword search is a JS shell**: curl returns only 2.5 KB, while the browser renders results
normally (62,667 measured).

**Browsing by journal, however, is static** — `frontiersin.org/journals/<journal>/articles`
returns 1.39 MB to curl. **To pull a whole journal, hand that path to fastpaper, not the browser.**

## ② What controls the page has

Results page `frontiersin.org/search?query=<query>&tab=articles`, **24 per page**.
The search box and submit button were **not measured separately**.

The page carries a **onetrust cookie banner** (`#onetrust-banner-sdk` is present).

## ③ Action · search

| Field | Selector | Hits |
| --- | --- | --- |
| Item container | `ul.entities-list.articles > li` | 24 |
| Title | `div.title` | 24/24 |
| Authors | `.authors` | 24/24 (names run together with no separator) |
| Type | `.article-type` | 24/24 (e.g. `Systematic Review`) |
| Date | `.date` | 24/24 (`Published on 20 Nov 2020`) |
| Article id | `a[data-test-id]@data-test-id` | 24/24 (shaped like `article_navigate_610967`) |

**Paging is not explored.**

> ⚠ **This page does not scroll.** Measured: after `window.scrollTo(0, scrollHeight)` the
> `scrollY` stays **0** and the item count does not change (24→24). Most likely the onetrust
> banner locks scrolling, and it will also intercept clicks (the `browser.click_intercepted`
> shape). **Deal with the banner before paging.**

## ④ Action · getting access

Public, no login.

## ⑤ Action · detail page

**The title is not a link.** The `<a>` wrapping each item has **no href**, and the whole page has
only 27 `<a>`, 24 of which point at `altmetric.com`. So `extract` cannot get landing-page
addresses; only text can be extracted.

**Clicking an item opens a new tab.** To keep working there, swap `tabId` for the newly opened one
reported in the tool result (see `references/browser.md`).

## ⑥ Action · getting the full text

**Not explored** — no detail page was visited, and the results page carries no direct PDF link.

## ⑦ When you must hand over to a human

When the cookie banner blocks an action and you cannot clear it.

## ⑧ Known limits

- Keyword search has no API, and curl cannot reach it (JS shell)
- Paging not explored; scrolling measured as ineffective
- Detail pages have no href, so they can only be clicked, and clicking opens a new tab
- Getting the full text is not explored
