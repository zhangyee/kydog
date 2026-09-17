# National Center for Philosophy and Social Sciences Documentation (NCPSSD) · operations card

Built by the Chinese Academy of Social Sciences and entirely free: 2400+ Chinese social-science
journals with 13.8M+ articles, plus 15k+ foreign OA journals.
Axis-A kind 2. Shared discipline is in `SKILL.md` §5 and §6.

> **Reconnaissance: measured 2026-09-16 inside KyDog's own IAB**; every selector carries a hit
> count. Anything not measured says "not explored".

## ① Reachability

Both the home page and the results page are fine. No Cloudflare.

## ② What controls the page has

| Control | Selector | Measured |
| --- | --- | --- |
| Search box | `#text_search` | **1/1** |
| Submit button | `#but_search` | **1** |

**Enter also submits, but its behaviour is to open a new tab.**

## ③ Action · search

Results page `/Literature/articlelist?sType=0&search=<base64>&searchname=<base64>&nav=0&ajaxKeys=<base64>`,
**10 per page**.

| Field | Selector | Hits |
| --- | --- | --- |
| Item container | `div.julei-list` | **10** |
| Title | `a[data-id]` | **10/10** |
| Detail page | **unobtainable** — the title's href is `javascript:void(0);` | — |

Paging uses `a.layui-laypage-next`, matching **1/1**, but **the address does not change**:

```jsonc
// The wait condition cannot use urlMatches — the address is identical before and after.
// Wait for the first result's index to change from 「1、」 to 「11、」.
{ "kind": "click", "selector": "a.layui-laypage-next" }
```

> ⚠ **The query is base64 inside the address.** The `search=` segment is the base64 of a whole
> query-language expression (`(IKTE="深度学习" OR IKPYTE=… )`), and `ajaxKeys=` is the base64 of
> the query itself. **This is the hardest example of "never construct a search URL, interact"** —
> constructing it means encoding a query language of your own, and a site update kills it.

## ④ Action · getting access

Public, no login.

## ⑤ Action · detail page

**The title's href is `javascript:void(0);`**, so `extract` cannot get the address.
Clicking the title **opens a new tab**. To keep working there, swap `tabId` for the newly opened
one reported in the tool result (see `references/browser.md`).

## ⑥ Action · getting the full text

**The full-text entries are on the result card, not on the detail page.**

| Entry | Selector | Hits |
| --- | --- | --- |
| Read full text | `a.house:not(.r100)` | **10/10** |
| Download full text | `a.house.r100` | **10/10** |

> ⚠ **Both have `href="javascript:void(0);"`** — the real path lives in the onclick
> (`/Literature/readurl?id=<id>`). `extract` **cannot get the address**; using it means clicking.
> When extracting, all you can report is a boolean "full text available or not".

## ⑦ When you must hand over to a human

Site features that need a login. None of this card's actions use them.

## ⑧ Known limits

- No public search API
- **Neither detail-page nor full-text addresses are obtainable** (all `javascript:void(0);`)
- **Paging cannot wait on the URL**; only on the first result's index changing
- **A new tab pops twice** (once on Enter-submit, once on clicking a title)
