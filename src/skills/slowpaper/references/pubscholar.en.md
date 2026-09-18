# PubScholar · operations card

The public-good academic platform run by the CAS National Science Library; about 108 million
searchable records, and **the broadest free entry point for Chinese-language literature**.
Axis-A kind 2. Shared discipline is in `SKILL.md` §5 and §6.

> **Reconnaissance: measured on the live site 2026-09-16** (viewport 1280); every selector
> carries a hit count. Anything not measured says "not explored".

## ① Reachability

curl returns only a **1.9 KB SPA shell**; the browser renders normally (202,084 results
measured). No Cloudflare.

## ② What controls the page has

| Control | Selector | Measured |
| --- | --- | --- |
| Search box (home) | `.AppSearchBar input` | **2 matches** — the other is a type dropdown, so narrow further |
| Search box (results header) | `.AppHeaderSearchBar__inputInner input` | **1** |
| Submit button (home) | `button.AppSearchBar__button` | **1** |
| Advanced search | `button.AdvancedSearchButton` | **1** |

**Enter also submits** — the opposite of Scholar and Baidu Xueshu.

## ③ Action · search

The results address is always `https://pubscholar.cn/explore`, **with no query in it**.

| Field | Selector | Hits |
| --- | --- | --- |
| Item container | **`div.List__item:not(.List__item--skeleton)`** | 10 per page |
| Title / authors / journal / abstract | **text only**; there are no usable field selectors | — |
| Total hits | on the 「主题: …」 filter chip (202,084 measured) | — |

**There is no paging control** (`[class*=agination]` matches 0); it loads on scroll.

> ⚠ **The container must carry `:not(.List__item--skeleton)`.** A bare `div.List__item` picks up
> the loading skeleton row (measured as the 11th), which extracts as an empty row.

> ⚠ **`urlMatches` has nothing usable on this source** — the address is always `/explore`.
> Waits can only be expressed as DOM conditions.

> ⚠ **After extracting page 1, check that the 「主题: …」 filter chip is there.** If it is not,
> **the query never landed** and the page is browsing the whole corpus (one measured run showed
> 108 million records instead of results).

## ④ Action · getting access

Public, no login.

## ⑤ Action · detail page

**The title is not a link.** The only `<a href>` in an item points at an author profile
(`/microapp/profile/info/`), so `extract` **cannot get the detail address**. What clicking does
is **not explored**.

## ⑥ Action · getting the full text

**Not explored** — the results page carries no extractable full-text entry.

## ⑦ When you must hand over to a human

Site features that need a login (favourites, subscriptions). None of this card's actions use them.

## ⑧ Known limits

- No public search API, and curl only gets the SPA shell
- **Detail addresses are unobtainable** (the title is not a link)
- **No paging control**, loads on scroll; `urlMatches` has nothing usable
- Getting the full text is not explored
- An SPA with **no main-frame navigation**, so every step needs its own `wait` condition
