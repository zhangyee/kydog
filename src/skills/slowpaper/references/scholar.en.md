# Google Scholar

A discovery layer; it does not host full text. The widest coverage of all: preprints, theses,
patents and grey literature, with an "all versions" cluster and direct PDF links.
**It has no official API** — one of the reasons it has to go through a browser.

---

## Reconnaissance status

**Reconnaissance completed 2026-09-08.** Every selector below was read off the DOM of a real
results page (query `flow matching generative models`, about 491,000 results, 10 per page).

**A hard 403 wall was hit and reproduced along the way**: on the first network egress, search
was 403 across the board and recovered after changing IP. That is not this source's normal
state, but it is a state you **will really run into and must be able to recognise** —
fingerprint below.

---

## Mode of operation: interactive

**Everything is done on the page**: find the control, click it, type, submit. Do not construct
search URLs to bypass the page.

The reason is not fastidiousness:

- Constructing URLs means maintaining a parameter contract per source, and parameters change
  and grow signatures; when one breaks it does not error, it just returns nothing
- The page may have no constructible URL at all (when search is JS-driven)
- Interaction follows the site's real user path

**Interaction is not expensive.** One `browser_act` call carries a string of actions, and once
worked out, `selector` targeting makes it a playbook you can copy verbatim — with no snapshot
needed at all.

### Playbook: search from the home page

```jsonc
browser_open({ url: "https://scholar.google.com/" })
browser_act({ tabId: "<tabId from the previous step>", actions: [
  { "kind": "type",  "selector": "input[name=\"q\"]", "text": "<query>" },
  { "kind": "click", "selector": "#gs_hdr_tsb" }
]})
```

When `type` carries a `selector` it focuses that element first; no extra `click` is needed.
**It also selects-all and clears first**: if it cannot clear the box it reports an error and
types nothing at all (it never appends to existing content) — so reusing a box that already has
content mid-flow can hit `browser.target_unusable`, and that is not a wrong selector.

**Click the submit button here rather than pressing Enter.** During reconnaissance, pressing
Enter in the input box **did not submit** — the live value was already the query and the
element was focused, yet the page did nothing. Baidu Xueshu behaved the same.

**There is a candidate explanation, but it has never been re-verified.** Chromium's implicit
form submission happens on `keypress`, and CDP's `dispatchKeyEvent` only produces a char event
when it is a `keyDown` carrying `text`; this project's key table gives `Enter` its `text`
(`KEYS` in `actions.ts`) — so **that negative observation may have been the reconnaissance
tool's problem**. But "these two sites really do submit under this project's `key` action" has
**never been measured by this project**, so it remains an open question, not a conclusion.

**Until it is re-verified, always click the submit button.** Clicking also holds for sites
whose submit control is not a `type=submit`, and it is the only route measured to work. If the
Enter route is in fact still dead, `browser_act` reports no error and waits for no navigation,
and the `extract` that follows runs against the home page's DOM — the return value looks
entirely normal with a row count of 0. The page reports nothing, and you will think you
searched.

Then extract results with the playbook under "How to page".

**Never write `index` into a playbook.** Snapshot indices are a product of "this one opening
of this page" and drift with every new session; `index` is for exploration only (you clicking
while looking at a snapshot), and once worked out it is always replaced by `selector`.

## Reachability (measured)

Reachability **depends on the network egress**, and both states were measured:

| | Home page | Search |
| --- | --- | --- |
| Egress A (judged automated) | **200**, renders normally | **403** static interception page |
| Egress B (after changing IP) | **200** | **200**, normal results page |

Three further things were checked on egress A, all with the same conclusion: **opening the home
page first and submitting from its form, switching to Chrome, and switching to Safari while
signed in to a Google account were all still 403**. Therefore

- What is blocked is the act of searching itself, regardless of how it is initiated — do not
  waste turns slowing down or imitating a human
- **Signing in to a Google account does not unblock it** — do not treat "have the user log in"
  as a solution

## Interception-page fingerprint (measured)

```
HTTP 403
document.title === 'Sorry...'
body contains "your computer or network may be sending automated queries"
no <form>, no reCAPTCHA, not a single element with an id
```

**This is a hard wall, and a human cannot solve it either** — there is nothing interactive on
the page, and the only way out is a different network egress.

So when you meet it, do **not** call `ask_user_question` to bring the user in (they could only
stare at it). The correct reaction is to **switch to Baidu Xueshu** per the rule in `SKILL.md`,
and to note in the output that this round used Baidu Xueshu and that Scholar was unreachable.

Judge on the `HTTP 403` phrase in the tool result (the navigation-conclusion line reads
「但服务器返回 HTTP 403」); do not match strings in the body. **There is no `httpStatusCode`
field for you to read** — the status code only ever appears as that prose.

**The 403 arrives after the search is submitted, so it is not in that batch's result** (see the
reachability table above: the home page is 200 and only the search is 403, and `browser_act`
does not wait for navigation). It is hung on the `导航: [tab_…] 已打开 …，但服务器返回 HTTP 403`
line at the **head of the next** tool result, **reported once and then cleared** — so look at
that line on the first call after submitting a search.

## What controls the page has (measured, read off the home page DOM)

The home page has two usable search entry points, both real `<form>`s:

**① The home-page search box** (simple search)

- Input `input[name="q"]` (id `gs_hdr_tsi` on the home page)
- Submit button `input[name="btnG"]` (id `gs_hdr_tsb`), or press Enter in the input

**② The advanced search form** (fields on the page, filled in one by one, interactively)

| Field name | What it is on the page |
| --- | --- |
| `as_q` | with all of the words |
| `as_epq` | with the exact phrase |
| `as_oq` | with at least one of the words |
| `as_eq` | without the words |
| `as_occt` | where the words occur, single choice: `any` (anywhere in the article) / `title` (in the title of the article) |
| `as_sauthors` | authored by |
| `as_publication` | published in |
| `as_ylo` / `as_yhi` | year from / to |

The field names were read off the page's form and are used directly as selectors in a playbook
(`input[name="as_sauthors"]` and the like) — they are **not** for constructing URLs.

## How to extract the results page (measured)

Results page URL shape `https://scholar.google.com/scholar?q=<query>&hl=<lang>&as_sdt=0,5`,
**10 per page**.

Item container: `.gs_r.gs_or.gs_scl`.

| Field | Selector | Notes |
| --- | --- | --- |
| Title | `h3.gs_rt a` | |
| Paper page | `h3.gs_rt a@href` | The publisher's or preprint server's landing page, e.g. `arxiv.org/abs/2210.02747` |
| **Direct PDF link** | `div.gs_ggs .gs_or_ggsm a@href` | The block on the right. **Not every item has one** |
| PDF source label | `div.gs_ggs .gs_or_ggsm a` | Text shaped `[PDF] arxiv.org`, `[PDF] iclr.cc`, `[PDF] openreview.net` |
| Authors/venue/year | `div.gs_a` | One whole line, shaped `Y Lipman, RTQ Chen… - arXiv…` |
| Abstract snippet | `div.gs_rs` | |
| Citation count | `.gs_fl a.gs_or_cited` | Text 「被引用次数：7347」 / "Cited by 7347"; the href is `/scholar?cites=<clusterId>` |
| All versions | `.gs_fl a[href*="cluster="]` | Text 「所有 N 个版本」 / "All N versions" |
| Related articles | `.gs_fl a[href*="related:"]` | |
| HTML version | `.gs_fl a.gs_or_nvi` | Only present when there is a cache |

**The direct PDF link is the most valuable cell this source has** — it points straight at where
an open copy lives. All 10 items in this search had one, but **that correlates strongly with
the query and must not be taken as normal**: not extracting one means this item has no open
copy. This release only reports it, it does not fetch it (see below).

The "save" and "cite" `a`s inside `.gs_fl` have `javascript:void(0)` hrefs — **they are not
links, do not take their hrefs**.

## How to page (measured)

The paging area is `#gs_n`, and inside it are **real `<a href>`s** (unlike Baidu Xueshu, where
they are all `div`s with no role). The current page is a `<b>` with no link.

Target "next page" with **`#gs_n a:has(.gs_ico_nav_next)`** — measured to match exactly 1
element, and **independent of interface language**. Do not match on the words 「下一页」:
with `hl=en` it is `Next`.

The playbook for paging and extracting. **One `browser_act` per page; do not put it inside a
`repeat`** — every round of a batch carries the same wait condition, while "which page we got
to" differs page by page (`references/browser.md` §5).

Extract the current page:

```jsonc
{ "kind": "extract", "selectors": {
    "item": ".gs_r.gs_or.gs_scl",
    "title": "h3.gs_rt a",
    "page": "h3.gs_rt a@href",
    "pdf": "div.gs_ggs .gs_or_ggsm a@href",
    "meta": "div.gs_a",
    "cited": ".gs_fl a.gs_or_cited"
}}
```

Turning to the next page is **its own call**; afterwards send **another call** that extracts
with the same selectors as above:

```jsonc
{ "kind": "click", "selector": "#gs_n a:has(.gs_ico_nav_next)" }
```

**Scholar's paging really is a real link and really does go through a main-frame navigation —
but `browser_act` does not wait for navigations.** A click dispatches two mouse events and
returns (`browser.md` §5 rule 2). So "it navigates, therefore no `wait` is needed" is wrong,
and after that click you **must confirm for yourself that the page really changed**.

**The closing snapshot of that batch does not count.** Once the last step has run,
`browser_act` takes the "── 页面变化 ──" section **immediately**, without waiting for the
navigation (end of §5 in `references/browser.md`) — so after a paging click or a search submit
that section is **most likely still the previous page**. **Never click again just because it
looks unchanged**: Scholar is most sensitive to actions in quick succession, and that extra
click is exactly the shape that falls into a 403. Whether the page actually changed is told by
the `导航: [tab_…]` line at the head of the **next** tool result (a main-frame navigation is hung
there as soon as it settles, reported once and then cleared).

**How to confirm**: after extracting, compare this page's first `title` with the previous
page's first one — **identical means the page has not changed yet**; do not record it as a new
page and do not page on. That is exactly the shape of "extracting the first page three times
while every result looks normal".
(A condition that is false before the click and true after paging has not been measured this
release — see "Completion procedure".)

On the last page that `click` errors out because nothing matches — expected behaviour, and the
data from every earlier page is already in that page's own tool result.

**Do not page too far.** Scholar is far more sensitive to rapid consecutive paging than to a
single search, and falling into a 403 mid-way costs you the whole round in a source switch.

## What to do with PDF links: report, do not download

**This release only searches this source, it does not fetch PDFs.** The browser has no download
tool, and downloads the page triggers itself are refused outright.

The direct links extracted from `div.gs_ggs .gs_or_ggsm a@href` were measured pointing at
`arxiv.org/pdf/…`, `iclr.cc`, `neurips.cc` and `openreview.net`. **Report them verbatim** and
do not try to fetch them.

One exception is worth doing on your own initiative: when a direct link or a landing page
points at **arXiv / PMC / DOI**, hand the identifier to `fastpaper download` — it routes by
identifier and is far cheaper than the browser. The browser's value ends at "found it".

A bare PDF URL (`openreview.net/pdf?id=…` and the like) is not a shape fastpaper accepts, so
**this release stops at the link**.

## When you must hand over to a human

- **Not** for the 403 hard wall (see above — a human cannot solve it either; switch source)
- Otherwise follow the handover rules in `references/browser.md`

## Known limitations

- No official API; strong anti-scraping, and the act of searching is 403'd outright for an
  egress judged to be automated
- Usually needs a proxy from mainland China
- Citation counts are Scholar's own measure and disagree with Web of Science / Scopus —
  **do not report them as authoritative citation counts**

---

## Completion procedure

Step 1 (reconnaissance) is done; **step 2 has not been done yet**:

2. **Verification**: once the substrate is built, run every selector above for real through
   this project's `browser_act` `extract` action, fix the ones that do not work, and join
   "open the home page → search → page and extract" into one playbook that runs end to end.
   **The paging step must also come back with a condition that is false before the click and
   true after paging** (the page/offset segment of the result page's address is the most
   promising one; `urlMatches` tests the address the main process holds and never enters the
   page) — until then the only check is "compare the first title", above

This step cannot be skipped: two toolchains do not necessarily see the same DOM (login state,
UA, and whether a proxy is in play can each make Scholar return a different version of the
page). **Until they have been run through our own tools, the selectors above are only
candidates.**
