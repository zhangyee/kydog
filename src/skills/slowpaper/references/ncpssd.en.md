# National Center for Philosophy and Social Sciences Documentation (NCPSSD) · operations card

Built by the Chinese Academy of Social Sciences and entirely free: 2400+ Chinese social-science
journals with 13.8M+ articles, plus 15k+ foreign OA journals.
Axis-A kind 2. Shared discipline is in `SKILL.md` §5 and §6.

> **Reconnaissance: measured 2026-09-16 inside KyDog's own IAB; submit, new tab and paging
> re-measured 2026-09-17**; every selector carries a hit count. Anything not measured says "not explored".

## ① Reachability

Both the home page and the results page are fine. No Cloudflare.

On 2026-09-17 the home page carried a notice: **the domain is moving from `www.ncpssd.org` to `www.ncpssd.cn`**.
The same day `.org` still worked; if `.org` ever fails to open, try `.cn` before drawing a conclusion. The home
page is occasionally very slow (once that day the search box had not appeared after 30 s) — wait for `#text_search`
before acting.

## ② What controls the page has

| Control | Selector | Measured |
| --- | --- | --- |
| Search box | `#text_search` | **1/1** |
| Submit button | `#but_search` | **1** |

**How submit is implemented** (2026-09-17: read the site script `master.js` and measured in the IAB): the
search box's `keydown` handler turns Enter into `$("#but_search").click()`, and the button's `onclick` is
`Basicsearch()`. It **clears the search box first, then `window.open`s the results page in a new tab** —
**the results are never in the current tab.**

**Submit with Enter, not the button.** `type` focuses the search box by selector, without coordinates, so
focus is already in the box when it finishes; press Enter right after. Measured, clicking the button also
submits; but in the 2026-09-17 group-one acceptance run, "click the button" and "click the search box, then
press Enter" both failed to trigger a search (the box was not cleared, so `Basicsearch()` never ran), and four
different IAB configurations could not reproduce it — what the two attempts had in common is that both relied
on a coordinate click, which the Enter route does not.

## ③ Action · search

Results page `/Literature/articlelist?sType=0&search=<base64>&searchname=<base64>&nav=0&ajaxKeys=<base64>`,
**10 per page**.

| Field | Selector | Hits |
| --- | --- | --- |
| Item container | `div.julei-list` | **10** |
| Title | `a[data-id]` | **10/10** |
| Detail page | **unobtainable** — the title's href is `javascript:void(0);` | — |

### Playbook: a search takes two calls (measured working 2026-09-17)

```jsonc
// Call 1: submit on the home page. Wait for "the search box got cleared" — the page's signal
// that Basicsearch() really ran.
browser_act({ tabId: "<the home-page tab>", actions: [
  { "kind": "type", "selector": "#text_search", "text": "<query>" },
  { "kind": "key",  "key": "Enter" },
  { "kind": "wait", "until": { "selector": "#text_search:placeholder-shown", "state": "present" } }
]})
// The tool result ends with a line like "这一批里新开了 1 个标签页 …: [tab_…] …/Literature/articlelist?…"

// Call 2: switch tabId to that new tab, and wait and extract there.
browser_act({ tabId: "<the newly opened tab>", actions: [
  { "kind": "wait", "until": { "selector": "div.julei-list", "state": "present" } },
  { "kind": "extract", "selectors": { "item": "div.julei-list", "title": "a[data-id]" } }
]})
```

- **Do not wait for `div.julei-list` on the home-page tab.** The results are in the new tab, so waiting on
  the original tab never succeeds — and the timeout message only says "the condition did not hold", which
  looks as if the search was never sent.
- The `wait` in call 1 timing out = **the search box was not cleared = the search was not sent**. Do not
  switch to clicking the button and retrying; report it as it is.
- To search another term, go back to the home-page tab and repeat call 1 (`type` clears before typing).
  Every search opens another results tab, so **search NCPSSD at most two or three times per task** and do
  not fill up the tabs (`SKILL.md` §4: no more than 3 tabs per task).

### Paging (measured working 2026-09-17)

`a.layui-laypage-next` matches **1/1**. **The address does not change and there is no loading indicator**, so
`urlMatches` is out; and the first result's index (「1、」 → 「11、」) is text, which `wait` cannot match. What
you can wait on is the pager: after turning to page N, "previous" carries `data-page="N−1"`; **page 1 has no
"previous" at all** (measured 0). It is swapped in on the same frame as the result list; measured on 1→2 and
2→3, both extracted the new page.

```jsonc
// Turn to page 2 (for page 3 swap '1' for '2')
browser_act({ tabId: "<the results tab>", actions: [
  { "kind": "click", "selector": "a.layui-laypage-next" },
  { "kind": "wait",  "until": { "selector": "a.layui-laypage-prev[data-page='1']", "state": "present" } },
  { "kind": "extract", "selectors": { "item": "div.julei-list", "title": "a[data-id]" } }
]})
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
