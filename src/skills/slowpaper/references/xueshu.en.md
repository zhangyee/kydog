# Baidu Xueshu (百度学术)

A discovery layer for mixed Chinese/English search: good Chinese coverage, uneven result
quality, wired into document delivery. **It has no official API.**

---

## Reconnaissance status

**Reconnoitred 2026-09-08; the results-page structure was captured.** One gap remains:
**submitting a search interactively from the home page was never made to work** (Enter did not
trigger submission, and clicking `.send-btn` had no effect), so the search playbook below is
unverified. The results page itself is a real page that was opened, and all selectors were read
off its DOM.

One correction: the first path tried was `/s?wd=...` (the old-version path), which returned
403 plus a human-verification page; **the new results page is at
`/ndscholar/browse/search?wd=...`**. Going through page interaction cannot hit the wrong
endpoint — constructing URLs can. That is exactly where the "everything through interaction"
rule comes from.

---

## Mode of operation: interactive

**Everything is done on the page.** For this source especially: the home page has **no `<form>`
element at all** (measured), search is entirely JS-driven, and there was never a form URL to
construct.

One `browser_act` call carries a string of actions, and once worked out, `selector` targeting
makes it a playbook you can copy verbatim.

### Playbook: search from the home page (partly worked out)

```jsonc
browser_open({ url: "https://xueshu.baidu.com/" })
browser_act({ tabId: "<tabId from the previous step>", actions: [
  { "kind": "type",  "selector": "textarea.search-input", "text": "<query>" },
  { "kind": "click", "selector": ".send-btn" },
  { "kind": "wait",  "until": { "selector": "div.paper-wrap.result", "state": "present" } }
]})
```

**That `wait` is not a safety margin, it is required.** This source's search produces **no
main-frame navigation** (the SPA swaps a route), so the tool layer has no navigation outcome to
wait for; without explicitly waiting for result items to appear, the `extract` right after it
runs against the stale DOM and extracts the previous page — **and reports no error at all**.

**The closing snapshot does not wait either.** Once the last step of a batch has run the tool
takes the "── 页面变化 ──" section immediately (end of §5 in `references/browser.md`). This
source produces no main-frame navigation, so whether that section is fresh depends entirely on
the `wait` above: if it came true the page really did change; if it timed out the condition did
not hold and it is handled under stop-on-error — **do not** click submit again just because the
page-change section looks unmoved.

When `type` carries a `selector` it focuses that element first; no extra `click` is needed.
**It also selects-all and clears first**: if it cannot clear the box it reports an error and
types nothing at all (it never appends to existing content) — reusing a box that already has
content mid-flow can hit `browser.target_unusable`, and that is not a wrong selector.

**Enter failed to submit during reconnaissance** (Scholar behaved the same). **There is a
candidate explanation, but it has never been re-verified**: a CDP `keyDown` without `text`
produces no `keypress`, Chromium's implicit form submission happens on `keypress`, and this
project's key table does give `Enter` its `text` (`KEYS` in `actions.ts`) — so that negative
observation may have been an artifact of the reconnaissance tool. But whether this site actually
submits under this project's `key` action **has never been measured here**; it remains an open
question, not a conclusion. This source's home page has **no `<form>`** anyway, so implicit
submission was never on the table: explanation or not, submitting means clicking `.send-btn`.

Clicking the send button `.send-btn` is the preferred path, **but it was never made to work
during reconnaissance** (see "Reconnaissance status" above — neither playbook's submit step
succeeded this round), so do not treat it as a verified step. Its class is `send-btn disable`
before the input has content and becomes `send-btn` once it does — that change can serve as a
"ready to submit" test, and makes a good condition for a `wait` action. In the other toolchain
used for reconnaissance it **did not appear in the accessibility tree**; this project's walker
has a wider inclusion set (`div`s carrying `role` / `onclick` / `tabindex` do enter a snapshot),
so **do not assume it is absent from the snapshot** — playbooks use `selector` regardless, so
this makes no difference to them.

**`type` always goes in as text insertion (`Input.insertText`), produces no `keydown`, and does
not branch on character class** — Chinese and English query terms take **the same path**; there
is no such thing as "English is the safe route". If "the button becomes usable once there is
content" is driven by `keydown`, then **any** query term may leave the button unusable; confirm
this during re-verification, and if the button does not become usable, take a snapshot before
clicking.

### Playbook: advanced search (partly worked out)

Advanced search is a dialog; it has to be opened before it can be filled in:

```jsonc
browser_act({ tabId: "<tabId from the previous step>", actions: [
  { "kind": "click", "selector": "<the 「高级检索」 button, see the note below>" },
  { "kind": "wait",  "until": { "selector": "#advanced-search-all", "state": "present" } },
  { "kind": "type",  "selector": "#advanced-search-all",    "text": "<all of these terms>" },
  { "kind": "type",  "selector": "#advanced-search-author", "text": "<author>" },
  { "kind": "click", "selector": "<the 「确认」 button, see the note below>" },
  { "kind": "wait",  "until": { "selector": "div.paper-wrap.result", "state": "present" } }
]})
```

**These two `wait`s are the same rule as the one in the home-page playbook** (this source's
`click` produces no main-frame navigation, so every `click` must be followed by a condition you
supply). Without the first one, the `type` resolves its target at the same moment as the
"open the dialog" click — and at that moment `#advanced-search-all` does not exist yet, so what
you get is `browser.target_unusable`「在当前页面上没有匹配」 even though the selector is
correct; swapping selectors on that advice is going round in circles on a dead end. Without the
second one, the `extract` right after it runs against the stale DOM.

**Neither playbook's submit step has ever succeeded in this round** (submission gave 403 plus a
human-verification page, see below). The input selectors were read off the home page DOM and do
really exist; whether submitting reaches a results page was not verified.

**Never write `index` into a playbook.** Snapshot indices drift with every new session;
`index` is for exploration only and is always replaced by `selector` once worked out.

## Reachability (measured)

| Endpoint | Result |
| --- | --- |
| `https://xueshu.baidu.com/` (home page) | **200**, renders normally, title 「百度学术 - 保持学习的态度」 |
| The search endpoint | **403**, human-verification page |

## Interception-page fingerprint (measured)

```
HTTP 403
document.title === '百度安全验证'
body contains 「校验失败，请再试一次」 and 「请依次点击…」
```

**This is an interactive click-to-select CAPTCHA and a human can solve it** — unlike Google
Scholar's static hard wall.

So the correct reaction is to **hand it to the user with `ask_user_question`** (carrying
`browserTabId`, which makes the sidebar expand to that tab) and prompt them to complete the
verification. Once they do, the cookie lands in the persistent partition and later searches
reuse the same session.

While suspended, **do not read the page** and do not click anything on the user's behalf.

Judge on the `HTTP 403` phrase in the tool result (the navigation-conclusion line reads
「但服务器返回 HTTP 403」); **there is no `httpStatusCode` field for you to read** — the status
code only ever appears as that prose. Whether it is interactive is judged by whether the
snapshot contains a clickable verification control.

**A 403 that only arrives after the search is submitted** (see the reachability table: home
page 200, search 403) is not in that batch's result — it is hung on the `导航: [tab_…]` line at
the **head of the next** tool result, reported once and then cleared.

## What controls the page has (measured, read off the home page DOM)

**The main search box is a `<textarea>`, not an `<input>`**:

```
textarea.atomic-textarea-box.search-input     no name, no id
```

It can only be recognised by class, or by role / position in the snapshot. **Do not look for it
as `input[name=...]`.**

**Advanced search is a dialog**: click the 「高级检索」 button to open it, then fill the fields
one by one. The field ids are semantic and stable:

| id | Meaning | Notes |
| --- | --- | --- |
| `#advanced-search-all` | contains all of these terms | |
| `#advanced-search-precise` | exact match | placeholder text 「多个检索词以，分隔」 |
| `#advanced-search-or` | contains any of these terms | as above |
| `#advanced-search-not` | without these terms | as above |
| `#advanced-search-author` | author | |
| `#advanced-search-affs` | affiliation | |
| `#advanced-search-publication` | journal | |
| `#advanced-search-year-start` / `#advanced-search-year-end` | year range | |

The dialog also has three `input.ant-radio-input` radio options whose **meaning was not
confirmed in this round**; look at a snapshot before using them.

The submit button reads 「确认」 and cancel reads 「取消」. **Neither of those, nor the
「高级检索」 button, has an id**; their classes are a string of
`atomic-button atomic-md atomic-button-primary …` combinations — targeting by button text is
more stable in a playbook than by class (the classes are generated by a component library and
change with redesigns). Exactly how to write them will be settled against a real snapshot when
the reconnaissance is completed.

**An authorisation dialog may pop up on the page**: this round saw 「继续使用」 / 「取消授权」
buttons in the home page DOM. It was never actually triggered; handle it against the snapshot's
real content when you meet it, and do not assume it always appears.

The home page navigation includes a 「旧版入口」 (old-version entry) item, apparently leading to
the classic results page; this round did not locate its element form (it is not an `<a>`) and
never opened it. It is worth trying first when completing the reconnaissance — classic pages
are usually easier to extract than a new SPA.

## How to extract the results page (measured)

Results page URL shape `https://xueshu.baidu.com/ndscholar/browse/search?wd=<query>`,
**10 per page**.

Item container: `div.paper-wrap.result` (the full class is `paper-wrap result xpath-log`).

The internal structure of one item:

| Field | Selector | Notes |
| --- | --- | --- |
| Title | `h3.paper-title a` | The text is the title |
| Detail page | `h3.paper-title a@href` | Shaped `/usercenter/paper/show?paperid=<id>` |
| Abstract snippet | `div.paper-abstract` | Matched terms are wrapped in `<em>`; taking `innerText` is enough |
| Type | `div.paper-info span.paper-type` | 「期刊」 / 「学位」 / 「会议」 etc. |
| The whole metadata line | `div.paper-info` | Shaped `期刊 梁彤祥， 刘娟， 王晨 - 《材料工程》 - 被引量：33 - 2014年` |
| Citation count | `div.paper-info a[href*="refpaper"]` | The number only; 「被引量：」 is in a sibling span |
| Journal | `div.paper-info a[href*="/usercenter/data/journal"]` | |
| Authors | `div.paper-info a[href*="wd=author"]` | Several |
| **Full-text entry points** | `div.paper-source a@href` | **Several**; this is the key to getting full text |

`div.paper-source` is this source's most valuable block — it lists side by side where the same
paper can be found in various places. One item was measured carrying, at the same time: the
journal's own site (`jme.biam.ac.cn/...`), the National Science and Technology Library
(`nstl.gov.cn`), iAcademic, Wanfang (`d.wanfangdata.com.cn`) and CNKI (`cnki.com.cn`).

**Take all the `a`s and pick by domain**; do not take only the first — the one listed first is
not necessarily the one that leads straight to a PDF.

## How to page: not this release — first page only

**This release takes only the first results page from this source** (10 items per page). Once
you have extracted the first page you are done; do not try to page on.

**Why it is downgraded**: inside the paging control `div.pagination-wrap > div.pagination` a
page number is `div.page` and the current page is `div.page.active`, while "previous page" and
"next page" **share the same class `div.page.n`** and are separable only by text — while `browser_act`'s `selector` is **pure CSS** (a `querySelector` inside the page),
with **no `:contains()` / `:has-text()`-style text matching**. So both routes are dead ends:
`div.page.n:contains("下一页")` is rejected as an invalid selector (「不是合法的 CSS 选择器」,
`browser.bad_action`), while a bare `div.page.n` takes the **first** one — that is "previous
page", so clicking it pages **backwards**. These controls are also all `div`s with no `href`
and no role; in the other toolchain used for reconnaissance they did not enter the accessibility
tree, while this project's walker has a wider inclusion set (`[role]` / `[onclick]` /
`[tabindex]` are all taken in), so whether they enter a snapshot depends on the live page —
**but playbooks never write `index`** (indices drift with every new session), so that route is
no way out either. **Opening paging requires first measuring, against the live site, a CSS expression
that matches only "next page"** — see step 3 of the completion procedure.

Extract the first page; that one call ends this source:

```jsonc
{ "kind": "extract", "selectors": {
    "item": "div.paper-wrap.result",
    "title": "h3.paper-title a",
    "detail": "h3.paper-title a@href",
    "info": "div.paper-info",
    "sources": "div.paper-source a@href"
}}
```

**So this source yields at most 10 items this release.** The "at most 3 pages per source" in
`SKILL.md` §3 is the general cap; for Baidu Xueshu it is really only 1 page — a known limitation
of this release, not a failed extraction. If you need more results, narrow the query and search
again rather than making up the difference by paging.

## What to do with full-text entry points: report, do not download

**This release only searches this source, it does not fetch full text.** The browser has no
download tool, and downloads the page triggers itself are refused outright.

`div.paper-source a@href` gives a set of **external site** entry points, not direct PDF links.
The domains observed were `nstl.gov.cn` / `d.wanfangdata.com.cn` / `cnki.com.cn` /
`iacademic.info` and journals' own sites. **Report that set of links verbatim** and let the user
pick one to open.

Most of those sites need an institutional subscription — **institutional (CARSI) login is in
this release**, see `references/carsi.md`. But **this release still downloads nothing after
logging in**: even with subscription access you only report the link to the user; the download
channel is next release's work.

The left-hand filter panel has a 「获取方式 → 免费下载」 (free download) facet — 4679 items under
that search, as measured. **Filter on it first**, so the links you report are more likely to be
ones the user can simply open.

## When you must hand over to a human

- **403 plus the 「百度安全验证」 click-to-select CAPTCHA** — the main scenario, see above
- Features that need a login (favourites, document delivery requests, and so on)
- Otherwise follow the handover rules in `references/browser.md`

## Known limitations

- No official API; the act of searching gets 403 plus human verification for an egress judged
  to be automated
- Result quality is uneven; the same paper may appear as several duplicate records
- Many items go through document delivery rather than a direct link, so not getting a PDF is
  normal, not a fault

---

## Completion procedure

1. **Reconnaissance**: search once interactively in a real browser (clearing a CAPTCHA by hand
   if needed), open the results page, and read out the selectors for the item container, title,
   authors/year/venue, citation count, and full-text / document-delivery entry points, plus the
   form of the paging control. Try the 「旧版入口」 path while you are there
2. **Verification**: run every selector for real through this project's `browser_act` `extract`
   action, fix the ones that do not work, and chain "open the home page → search → extract the
   first page" into one playbook that runs end to end
3. **Open paging** (the step downgraded this release, reason under "How to page"):
   - First measure a **pure CSS expression that matches only "next page" and not "previous
     page"**. The two share `div.page.n`, and `selector` goes through `querySelector` inside the
     page with no text matching available — so the only handles are structural position
     (something like `div.pagination > div.page.n:last-of-type`) or an attribute that appears on
     only one of them. **Confirm on the live page that it matches exactly 1 element**; do not
     write a guess into the playbook
   - Then also come back with a **condition that is false before the click and true after
     paging**. A "current page" marker like `div.page.active` **will not do** — it already holds
     before the click, and `wait` probes once before it waits, so it returns "condition met"
     instantly, having waited not one millisecond (`references/browser.md` §5). The direction
     Scholar points at is worth trying here too: match the page-number/offset segment of the
     results-page address with `urlMatches` (which tests the address held by the main process
     and does not enter the page, see `references/scholar.md`) — **but whether this source's
     address changes at all when paging was not measured this release**, so measure it
   - Until that is done, "at most 3 pages per source" in `SKILL.md` §3 is really only 1 page for
     this source

Step 2 cannot be skipped: two toolchains do not necessarily see the same DOM.
