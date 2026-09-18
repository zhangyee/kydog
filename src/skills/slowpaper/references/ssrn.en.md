# SSRN · operations card

The main working-paper source for finance, management and law. Axis-A kind 2.
Shared discipline is in `SKILL.md` §5 and §6.

> **Reconnaissance: measured 2026-09-16 inside KyDog's own IAB** (it sits behind Cloudflare and
> nothing else gets in); every selector carries a hit count. Anything not measured says
> "not explored".

## ① Reachability

curl **403 Cloudflare**; in an external automated browser the checkbox re-challenges endlessly;
**KyDog's IAB gets through**.

> ⚠ **Submitting a search may raise one more challenge right then.** Measured: right after the
> submit, what came back was still the interstitial (`title` was 「请稍候…」), and **only a moment
> later did it become the real results page**. **Do not call it a failure on the spot**, and do
> not retry immediately — retrying is exactly the shape of the re-challenge loop.

## ② What controls the page has

| Control | Selector | Measured |
| --- | --- | --- |
| Search box | **`input#search`** | **1/1** |
| Submit button | `#search-button-with-text` | **1** |

**Enter also submits** (the current tab updates).

> ⚠ **Never write `#search` here.** On this site `#search` **matches both
> `<section id="search">` and `<input id="search">`** — one id on two elements. Only
> `input#search` matches 1. **Do not assume an id is unique**; this is not only SSRN.

## ③ Action · search

Results page `papers.ssrn.com/searchresults.cfm?term=<query>`, **50 per page**.

| Field | Selector | Hits |
| --- | --- | --- |
| Item container | `div.result-item` | **50** |
| Title / detail page | the title is itself an `<a href>` → `sol3/papers.cfm?abstract_id=<id>` | 50 |
| Pages / posted date / authors / affiliation / abstract snippet | **no class of their own**; read them out of the item's text | — |

**Paging is not explored.**

> ⚠ The item's full class is `div._boxReset_qveh9_1.result-item`, and the first half is a
> **CSS-module hash that changes whenever the site rebuilds**. **Write only `div.result-item`**
> (separately verified to match 50).

## ④ Action · getting access

Public, no login. Cloudflare is anti-bot defence, not an access right.

## ⑤ Action · detail page

Clicking the title gives **same-tab in-site navigation** to `sol3/papers.cfm?abstract_id=<id>`.
The detail page carries both "Download This Paper" and "Open PDF in Browser".

## ⑥ Action · getting the full text

| Entry | Selector | Hits |
| --- | --- | --- |
| Download PDF | `a.button-link.primary[href*='Delivery.cfm'][href*='.pdf']` | **2/2** (the UI appears twice) |
| Open PDF in browser | the same plus `[href*='type=2']` | **2/2** |

Real shape: `papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID<id>_code<code>.pdf?abstractid=<id>&mirid=1`
(the "open in browser" one adds a trailing `&type=2`). Fetch it with `browser_download` (it goes through this tab's session).

## ⑦ When you must hand over to a human

When Cloudflare appears — `ask_user_question` with `browserTabId`, one click is enough.
**Do not reload repeatedly to wait it out.**

## ⑧ Known limits

- No public search API
- **Only workable inside KyDog's IAB**
- Paging not explored
- An item's metadata is crammed into one block of text with no separate fields
