# Baidu Xueshu · operations card

A discovery layer for mixed Chinese/English search: good Chinese coverage, uneven result
quality, wired into document delivery. **No official API.**

> **Reconnaissance: measured on the live site 2026-09-16** (Chromium, viewport width 1280,
> the same width as KyDog's emulation). Every selector below was counted against the real DOM.
> **Not yet verified end to end through this project's `browser_act`** — that would also cover
> the walker's isolated-world execution, `extract`'s `item` alignment, and our own
> `type` / `click` hit-testing and auto-scroll. Where the page disagrees, trust the page.

---

## ① Reachability and the interception fingerprint

| Endpoint | 2026-09-16 | 2026-09-08 (first release) |
| --- | --- | --- |
| `https://xueshu.baidu.com/` (home) | **200**, renders normally | 200 |
| The results page after submitting a search | **200**, 10 results, **no CAPTCHA** | **403**, human-verification page |

**Both states are real**; which one you get depends on the network egress and session of the
moment. Do not write "it did not intercept me this time" as "this source does not intercept".

Interception fingerprint (measured 2026-09-08):

```
HTTP 403
document.title === '百度安全验证'
body contains 「校验失败，请再试一次」 and 「请依次点击…」
```

**This is a click-to-select CAPTCHA a human can solve** — unlike Google Scholar's static wall.
So call `ask_user_question` and hand it over (with `browserTabId`; the sidebar expands to that
tab). Once they clear it the cookie lands in the persistent partition and later searches reuse
the session. While it is pending, **do not read the page** and do not click anything for them.

Judge on the `HTTP 403` in the tool result (the navigation verdict line reads
「但服务器返回 HTTP 403」); **there is no `httpStatusCode` field to read**. Whether it is
interactive is answered by whether the snapshot holds a clickable verification control.

**The 403 that only arrives after the search is submitted is not in that batch's return
value** — the submit is a click on a `div`, not a plain link, so it carries no navigation
wait guarantee. It shows up in the **header** of the **next** tool result, on the
`导航: [tab_…]` line — reported once, then cleared.

---

## ② What controls the page has

**The home page has no `<form>` element at all** (measured: `document.forms.length === 0`);
search is entirely JS-driven, so there was never a form URL to construct.

| Control | Selector | Measured |
| --- | --- | --- |
| Main search box | `textarea.search-input` | **A `<textarea>`, not an `<input>`**, with no `name` and no `id`. Do not look for `input[name=…]` |
| Submit button | `.send-btn` | Class is `send-btn disable` while empty, becomes `send-btn` once there is content |
| Advanced-search opener | `div.advanced-search.advance-toggle-btn` | Labelled **「高级搜索」** on the page. See the warning in ③ — this route is not recommended |

**The button does not need a `keydown` to become usable.** Measured: dispatching a single
`input` event flips `.send-btn` out of `disable` — and KyDog's `type` uses `Input.insertText`
(which fires `beforeinput` + `input`, a superset of that), so **any query text will enable it**.
There is no Chinese/English branch.

**Do not expect Enter to work.** With no `<form>` on the page there is no implicit submission;
always click `.send-btn`.

---

## ③ Action · search

### Playbook: search from the home page (measured working 2026-09-16)

```jsonc
browser_open({ url: "https://xueshu.baidu.com/" })
browser_act({ tabId: "<tabId from the previous step>", actions: [
  { "kind": "type",  "selector": "textarea.search-input", "text": "<query>" },
  { "kind": "click", "selector": ".send-btn" },
  { "kind": "wait",  "until": { "selector": "div.paper-wrap.result", "state": "present" } },
  { "kind": "extract", "selectors": {
      "item":    "div.paper-wrap.result",
      "title":   "h3.paper-title a",
      "detail":  "h3.paper-title a@href",
      "type":    "div.paper-info span.paper-type",
      "info":    "div.paper-info"
  }}
]})
```

**That `wait` is not belt-and-braces, it is required.** The submit clicks a `div`, not an
`<a href>`, so it gets none of the navigation guarantee plain links carry. Without an explicit
wait for result items, the `extract` right after it runs against the home page's DOM and
returns 0 rows — **and reports no error at all**. The closing snapshot is the same story: it is
taken immediately after the last step, so whether it is fresh depends entirely on this `wait`.
A timeout is a failed action (stop-on-error); **do not** click submit again because the page
diff looks unchanged — see "Submit does nothing" below.

**The playbook extracts only the fields you need to judge relevance** (`SKILL.md` §4). Abstracts and
full-text entries are in the "Result-page fields" table — extract them once you have picked papers.
Full-text entries exist only on the results page, not on the detail page (⑥).

`type` with a `selector` focuses the element first, so no extra `click` is needed. **It also
selects-all and clears first**: if it cannot clear, it errors and types nothing — so reusing a
box that already has content can hit `browser.target_unusable`, which is not a bad selector.

The snapshot from `browser_open` on the home page is often empty (「（这一份快照里没有可交互元素）」,
"no interactive elements in this snapshot") — the home page is script-rendered and has not painted yet when the snapshot is
taken. **It does not affect selector-based actions**: run the batch above as is; do not `reload`
just to get indices.

### Submit does nothing (measured in acceptance groups 5 and 6, 2026-09-17)

**Symptom**: `已点击「div」（…）`, then the `wait` times out and the address does not change. Clicking
twice more and pressing Enter made no difference.

**First read the "requests sent" section of the tool result** (`browser.md` §6). The search endpoint
is `xueshu.baidu.com/search/api/search?wd=…`. Measured on 2026-09-18, one successful search sent 7 XHRs:
besides the search endpoint, 4 on-site odds and ends (unread messages, cloud-drive list, favourite checks
and so on) and two POSTs to `banti.baidu.com`. Those extras are there on success too, so **their presence
does not mean the search went out**. Only the search endpoint counts:

| The request section | What to do |
| --- | --- |
| 「没有发出任何」, or there are requests but none to the search endpoint | The click was not picked up and the search was never sent. Go to "Hand it to the user" below |
| The search endpoint 4xx / 5xx / network error | The site refused it. Follow the table under "When it will not open" in `SKILL.md` |
| The search endpoint 200 | Results are on their way. `wait` once more on the same selector, **without clicking submit**; if they still don't come, go to "Hand it to the user" |

**What is known**:

- In the same tab, **one manual click by the user brought up results**.
- The same "type + click submit" measured successful every time in a fresh session: sidebar open or
  closed, 1:1 or fit, typing and clicking in the same batch — the click lands on `.send-btn` and the
  search request goes out as usual.
- So the problem lies in this session's state on the site's side, **and the exact cause has not been
  found yet**; it is not a wrong selector.

**Hand it to the user**:

1. Do not click a second time, do not press Enter (the home page has no `<form>`, so Enter never
   submits anyway), do not `reload` and start over.
2. Call `ask_user_question` **with `browserTabId`**: "The search terms are filled in — please click the
   blue arrow at the right of the search box", offering "done" and "skip Baidu Xueshu". While waiting
   for the answer, do not read the page or click anything.
3. On "done": continue from the `wait` step of the home-page playbook and `extract` once result items
   appear. On "skip": switch source and say so in your reply.

**Do not fall back to building the URL yourself.** The legacy `/s?wd=…` measured on 2026-09-17 returns
200 and results can be extracted, but in group 6 the model itself reported that the type filter appended to the
address (`filter=sc_type…`) was **silently ignored** by the site — it looks like success while the filter
never took effect.

### Searching again with new terms: on the results page (measured working 2026-09-17)

After one search the tab sits on the results page. **Two parts of the home-page playbook do not
hold there:**

| Control | Home page | Results page |
| --- | --- | --- |
| Search box | `textarea.search-input` | **`input.search-input`** (1 match); `textarea.search-input` has **0** matches here |
| Submit | `.send-btn` | `.send-btn` (1 match; still click it) |

> ⚠ **Never write a bare `.search-input`.** It first matches the outer `div.atomic-input-wrapper`,
> and `type` reports 「不是能打字的控件（div）」 ("not a control you can type into").

**The wait condition has to change too.** Measured timeline after clicking submit: at about 0.2 s
the address changes to the new query first, **while the old 10 rows stay on the page**; at about
0.25 s a loading spinner `.ant-spin-spinning` appears over the results; at about 1 s the new
results replace the old ones and the spinner goes away. So:

- waiting for `div.paper-wrap.result` to appear — it already holds before the click, so it waits
  not one millisecond;
- waiting for `urlMatches` on the new query — the address has changed but the results are still
  the old ones. **The `extract` right after it returns the previous 10 rows, and reports no error**
  (reproduced by measurement; it also really happened in the 2026-09-17 group-one acceptance run).

Wait on the spinner instead: **first for it to appear, then for it to disappear**. It has 0
matches when the page is idle and only appears after submit. Measured over 7 re-searches
(including queries already used before), every one extracted the new results.

```jsonc
browser_act({ tabId: "<the same tabId>", actions: [
  { "kind": "type",  "selector": "input.search-input", "text": "<new query>" },
  { "kind": "click", "selector": ".send-btn" },
  { "kind": "wait",  "until": { "selector": ".ant-spin-spinning", "state": "present" } },
  { "kind": "wait",  "until": { "selector": ".ant-spin-spinning", "state": "absent" } },
  { "kind": "extract", "selectors": {
      "item":    "div.paper-wrap.result",
      "title":   "h3.paper-title a",
      "detail":  "h3.paper-title a@href",
      "type":    "div.paper-info span.paper-type",
      "info":    "div.paper-info"
  }}
]})
```

Two routes not to take (both were actually taken by the model in the 2026-09-17 group-one run):

- **Reopening the home page does not clear the results.** `browser_open` the home page on this tab
  again and the page jumps back to the previous results address by itself.
- **Constructing `/ndscholar/browse/search?wd=…` does not work either** (§2 already says there is no
  form URL to construct). Measured: it first bounces back to the home page, then a moment later
  renders that search's results asynchronously — the page state and the tool result disagree, and
  every step after that is led astray.

### Field search: put the syntax straight into the main box

**Do not open the advanced-search dialog.** This source's field syntax works in the main box:

```
author:(何恺明) 图像
```

Measured 2026-09-16: 4 results, every author matched. One round trip, none of the dialog's
traps. (Corroboration: every author name on a results page links to `search?wd=author%3A%28…%29`.)

> ⚠ **The advanced-search dialog does not work under this tool. Do not try it.** Three
> measured reasons:
> ① the results page carries **two elements with the id `#advanced-search-all`**, so which one
> `querySelector` returns is undefined;
> ② opening and closing the dialog **does not change whether those elements exist**, while
> `wait`'s `state` is only `present` / `absent`, tests `document.querySelector` truthiness and
> **ignores visibility** — so "click to open the dialog, then wait for it to appear" is
> guaranteed to be a no-op (the condition already holds before the click, and `wait` probes
> once first, so it returns "arrived" immediately);
> ③ the dialog's submit button `.button-group button.atomic-button-primary.operate-btn` is
> labelled **「高级检索」** while the opener is 「高级搜索」 — the two names are easy to swap.

### Paging (measured working 2026-09-16; wait condition completed 2026-09-17)

| Control | Selector | Measured |
| --- | --- | --- |
| Next page | `div.pagination > div.page.n:last-child` | **Matches exactly 1** |
| Previous page | `div.pagination > div.page.n:first-child` | Matches exactly 1 — **never write a bare `div.page.n`**, that returns "previous" and pages backwards |

The paging controls are `div`s with no `href` and no role, so they **may be absent from the
accessibility tree** — only `selector` can reach them.

**The wait condition has two parts.** After clicking next, the URL becomes `…&pn=10`; page 3 is
`pn=20` (`pn = (page − 1) × 10`) — it differs per page and does not hold before the click, so it
guarantees "which page we turned to"; `urlMatches` is judged against the main process's own
address and never enters the page.

**But the address changes first and the results are replaced later**, the same mechanism as
re-searching in the previous section: **extract right after `pn` and you get the previous page**
(measured 2026-09-17: extracting as soon as `pn=10` held returned page 1's 10 rows, with no error).
So after `pn`, wait for "spinner appears → spinner disappears".

One page per `browser_act`, **never inside a `repeat`** — every round of a batch shares one
wait condition, while "which page am I on" differs per page.

```jsonc
// Turn to page 2 and extract it (for page 3, swap pn=10 for pn=20)
browser_act({ tabId: "<the same tabId>", actions: [
  { "kind": "click", "selector": "div.pagination > div.page.n:last-child" },
  { "kind": "wait",  "until": { "urlMatches": "pn=10" } },
  { "kind": "wait",  "until": { "selector": ".ant-spin-spinning", "state": "present" } },
  { "kind": "wait",  "until": { "selector": ".ant-spin-spinning", "state": "absent" } },
  { "kind": "extract", "selectors": { "item": "div.paper-wrap.result", "title": "h3.paper-title a",
      "detail": "h3.paper-title a@href", "info": "div.paper-info" }}
]})
```

On the last page that `click` errors because nothing matches or the control is disabled —
expected behaviour, and every earlier page's rows are already in their own call's return value.

### Result-page fields (hit counts measured 2026-09-16)

Results page URL is `https://xueshu.baidu.com/ndscholar/browse/search?wd=<query>`,
**10 per page**. Item container: `div.paper-wrap.result` (full class
`paper-wrap result xpath-log`).

| Field | Selector | Hits |
| --- | --- | --- |
| Title | `h3.paper-title a` | 10/10 |
| Detail page | `h3.paper-title a@href` | 10/10, absolute, carries `&site=xueshu_se` |
| Abstract snippet | `div.paper-abstract` | 10/10. Matched terms are wrapped in `<em>`; take the text |
| Type | `div.paper-info span.paper-type` | 10/10. 期刊 (journal) / 学位 (thesis) / 会议 (conference) / 专利 (patent) … |
| Authors | `div.paper-info a[href*="wd=author"]` | 10/10, several |
| Whole metadata line | `div.paper-info` | Reads like `期刊 李颖，李秀宇，卢兆林，... - 《计算机工程与设计》 - 被引量：0 - 2022年` |
| **Full-text entries** | `div.paper-source a@href` | **9/10**, several. See ⑥ |

> ⚠ **Journal name, citation count and year have no selector of their own — read them out of
> the `div.paper-info` line.** The new SPA renders them as **`<span>`s with no class**. The two
> selectors from the first release — `div.paper-info a[href*="refpaper"]` (citations) and
> `div.paper-info a[href*="/usercenter/data/journal"]` (journal) — measure **0/10** on the new
> page; they are leftovers from the old one. Using them raises no error, it just leaves those
> two cells permanently empty.

---

## ④ Action · getting access

**Public, no login.** Neither searching nor reading a detail page needs an account.

The only thing that blocks you is the click-to-select CAPTCHA in ①, and that is anti-bot
defence, not an access right — hand it to a human rather than hunting for a login.

Logins exist for favourites, subscriptions and document-delivery requests; none of this
card's four actions needs them.

---

## ⑤ Action · detail page

The abstract on a results page is only a snippet. **The full abstract and the keywords exist
only on the detail page.**

```jsonc
browser_open({ url: "<the detail value extracted from the results page>" })  // /usercenter/paper/show?paperid=…
browser_read({ tabId: "<tabId from the previous step>" })
```

Measured 2026-09-16:

- `/usercenter/paper/show?paperid=…` **redirects to**
  `/ndscholar/browse/detail?paperid=…&site=xueshu_se`. Either address works; open whichever
  you extracted
- The whole page body is **1839 characters** — one `browser_read` takes all of it, well under
  its 20000-character cap
- The page carries: full abstract, keywords, authors, year, journal, read count, all sources,
  and similar articles

> ⚠ **Do not use the `.abstract` selector on a detail page.** It measures **9 hits**, all of
> them abstracts of the "similar articles", and this paper's own abstract is not among them.
> What comes back looks like abstracts and is somebody else's — with no error. For this
> paper's abstract use `browser_read`, not `extract`.

---

## ⑥ Action · getting the full text

**This source hosts no full text; it points at where to get it.** The general rules for getting
full text live in `SKILL.md` §5; downloads the page triggers itself are still cancelled outright.

**Extract full-text entries on the results page only** (the detail page does not have them; once you
page away you have to come back for them): `div.paper-source a@href` (9/10
measured). It lists, side by side, where the same paper can be reached — measured domains
include `nstl.gov.cn` (National Science and Technology Library), `qikan.cqvip.com` (VIP),
`d.wanfangdata.com.cn` (Wanfang), `cnki.com.cn` (CNKI), publisher sites, and iAcademic.

**Take every `a` and pick by domain**; do not take only the first — the one listed first is
not necessarily the one with a reachable PDF.

> ⚠ **Do not open a detail page in order to get full-text entries.** There those sources are
> **`div`s with no `href`** (`.all-version-item`), and the only real `<a>` inside `.source-wrap`
> is 文献互助 (document delivery). The trip returns no links.

Most of these sites need an institutional subscription — but **open one and look before you
talk about logging in** (`SKILL.md` §2): on a campus network or a VPN the user already has
access. For a federated login see `references/carsi.md`; **this release still does
not download** after a login, it only reports links.

The left-hand facet panel `div.filters-wrap` has 获取方式 → 免费下载 ("access → free download";
834 records on the query measured 2026-09-16, alongside 登录查看 "sign in to view" at 707).
Filtering with it makes the links you report more likely to open for the user.

> ⚠ **There is no selector you can hard-code for it.** Each `div.filter-field` in the panel is
> distinguished only by **position** (获取方式 was 4th on that query, but which fields exist and
> in what order varies with the query), the `div.filter-field-content` items differ only by
> their counts, and CSS has no text matching. So this is one of the few places you **must use a
> snapshot `index` + `snapshotId`**: take a snapshot, confirm which block is 获取方式, and click
> it inside that snapshot. If it is not in the snapshot, **skip it** — filtering is an
> optimization, not a requirement, and two extra round trips are not worth it.

For anything pointing at **arXiv / PMC / DOI**, hand the identifier to `fastpaper download` —
it routes by identifier and is far cheaper than the browser.

---

## ⑦ When you must hand over to a human

- **403 plus the 百度安全验证 click-to-select CAPTCHA** — the main case, see ①
- Site features that need a login (favourites, document delivery)
- External sites you land on that demand payment, terms acceptance, or personal details

Call `ask_user_question` **with `browserTabId`**; the UI opens the sidebar and switches to
that tab.

---

## ⑧ Known limits

- No official API; the search action draws a 403 plus human verification on egresses judged
  to be automated (it did not this time, which does not mean it will not)
- Result quality is uneven and **the same paper can appear as several records** — normalize
  titles and merge within one search
- Many records go through document delivery rather than a direct link; no PDF is normal, not
  a fault
- Journal / citations / year exist only inside the whole metadata line (see ③)
- The advanced-search dialog is unusable under this tool (see ③); use main-box field syntax
- The home page's navigation has a 旧版入口 ("classic entry") item, untried; if you try it,
  locate it from the snapshot of the moment rather than guessing a selector into a playbook
