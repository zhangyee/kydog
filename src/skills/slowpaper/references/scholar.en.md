# Google Scholar · operations card

A discovery layer; it does not host full text. The widest coverage there is: preprints,
theses, patents and grey literature, with an "all versions" cluster and direct PDF links.
**No official API** — one of the reasons it has to go through a browser.

> **Reconnaissance: measured on the live site 2026-09-16** (Chromium, viewport width 1280,
> the same width as KyDog's emulation). Every selector below was counted against the real DOM
> and paging was clicked through once.
> **Not yet verified end to end through this project's `browser_act`** — that would also cover
> the walker's isolated-world execution, `extract`'s `item` alignment, and our own
> `type` / `click` hit-testing and auto-scroll.
>
> **Added 2026-09-17** (group 3 of the research-workflow acceptance run, one real pass through this
> project's `browser_act`): result-page extraction (10 / 10 / 9 items) and paging (`start=10`,
> `start=20`) worked end to end. The same run hit a new kind of interception —
> **HTTP 429 + reCAPTCHA**, which recovered once a person solved it; see ①.

---

## ① Reachability and the interception fingerprint

Reachability **depends on the network egress**, and all four states below have been measured:

| Egress | Home | Search |
| --- | --- | --- |
| 2026-09-16, this run | **200** | **200**, normal results page, 10 items |
| 2026-09-17 (acceptance group 3) | **200** | **429**, redirected to Google's reCAPTCHA page; after a person solved it, back on the results page at **200**, and the next 2 pages were still 200 |
| Egress B (first release, after changing IP) | 200 | 200 |
| Egress A (first release, judged automated) | **200**, renders normally | **403** static interception page |

**A 200 on the home page does not imply a 200 on search.** Both the 403 and the 429 block the
search action itself. Three further things were checked on egress A, all with the same result:
opening the home page and submitting from the form, switching to Chrome, and switching to Safari
while signed in to a Google account were **all 403**. So

- do not waste turns slowing down or imitating a human
- **signing in to Google does not fix it** — do not treat "have the user log in" as a solution

### Hard wall: HTTP 403 (measured in the first release)

Interception fingerprint:

```
HTTP 403
document.title === 'Sorry...'
body contains "your computer or network may be sending automated queries"
no <form>, no reCAPTCHA, no element with an id at all
```

**This is a hard wall a human cannot clear either** — there is nothing interactive on the page,
and the only way out is a different network egress. So do **not** call `ask_user_question`
(the user could only stare at it too). The correct reaction is to **switch to Baidu Xueshu**
per `SKILL.md` §3, and to note in the output that this round used Baidu Xueshu and that
Scholar was unreachable.

### Solvable by a person: HTTP 429 + reCAPTCHA (measured once, 2026-09-17)

After the search is submitted, the address jumps to Google's own verification page, and the
tab's host changes from `scholar.google.com` to `www.google.com`. What the tool result shows:

```
导航: [tab_…] 已打开 https://www.google.com/sorry/index?continue=<the original search address>&…，但服务器返回 HTTP 429
snapshot: [1] presentation "reCAPTCHA"  [2] link "为什么会这样？" (plus 3 iframes not traversed)
page errors include https://www.google.com/recaptcha/enterprise/anchor?…
```

**A person can clear this one**, so hand it over as follows:

1. **Call `ask_user_question` once, with `browserTabId`** (this Scholar tab), and the sidebar
   switches to the verification page. Offer at least "solved, continue" and "skip Scholar".
   Do not first ask "should you go solve it" and then make a separate call with the tab —
   that is two round trips, and the call with the tab already lets the user choose to skip.
2. While waiting for the answer, **do not read the page and do not click anything**.
3. Once they answer "solved", **do not resubmit the search**: the `continue` in the
   verification page's address brings the tab back to the original search. Call
   `browser_tabs` first (it does not enter the page); its header should carry the line
   `导航: [tab_…] 已打开 https://scholar.google.com/scholar?…（HTTP 200）`. When you see it,
   `extract` straight away, then page as usual.
4. If they answer "skip", or `browser_tabs` shows the tab still on `www.google.com/sorry/…`:
   treat it as a 403 — switch to Baidu Xueshu and say so in the output.

### Telling which one it is

**Look at the status code first**, using the 「但服务器返回 HTTP 403」 or
「但服务器返回 HTTP 429」 in the tool result; do not match body strings. **There is no
`httpStatusCode` field to read.**

- `HTTP 403` → hard wall; switch source, do not call the user
- `HTTP 429` → then check the snapshot for `presentation "reCAPTCHA"`: present, hand it to the
  user; **absent** (not yet measured), treat it as a 403

**Both the 403 and the 429 appear after the search is submitted.** Scholar's submit control is a
form button, so it does not get the definite wait that plain `<a href>` links do: if the
navigation fact lands during that action, the submit's own return value carries the status code
(the 2026-09-17 429 arrived that way); if it lands later, it hangs on the **header** of the
**next** browser tool result, on the line `导航: [tab_…] 已打开 …，但服务器返回 HTTP 403` —
**reported once, then cleared**.

---

## ② What controls the page has

The home page has two usable search entries, both real `<form>`s.

**① Home search box** (simple search)

| Control | Selector |
| --- | --- |
| Input | `input[name="q"]` (id `gs_hdr_tsi` on the home page) |
| Submit | `#gs_hdr_tsb` (i.e. `input[name="btnG"]`) |

**② Advanced search form** (fields on the page, filled one by one, interactively)

| Field name | What it is on the page |
| --- | --- |
| `as_q` | with all of the words |
| `as_epq` | with the exact phrase |
| `as_oq` | with at least one of the words |
| `as_eq` | without the words |
| `as_occt` | where the words occur, radio: `any` (anywhere in the article) / `title` (in the title) |
| `as_sauthors` | authored by |
| `as_publication` | published in |
| `as_ylo` / `as_yhi` | year from / to |

The field names were read off the page's form and are used directly as selectors in a playbook
(`input[name="as_sauthors"]` and so on) — **they are not for constructing URLs**.

> ⚠ **The interface language follows the browser** (`hl=zh-CN` this run). So **never locate a
> control by its label text** — "下一页" is `Next` under `hl=en`. The paging selector below does
> not depend on language, and that is deliberate.

---

## ③ Action · search

### Playbook: search from the home page (measured working 2026-09-16)

```jsonc
browser_open({ url: "https://scholar.google.com/" })
browser_act({ tabId: "<tabId from the previous step>", actions: [
  { "kind": "type",  "selector": "input[name=\"q\"]", "text": "<query>" },
  { "kind": "click", "selector": "#gs_hdr_tsb" },
  { "kind": "extract", "selectors": {
      "item":   ".gs_r.gs_or.gs_scl",
      "title":  "h3.gs_rt a",
      "page":   "h3.gs_rt a@href",
      "pdf":    "div.gs_ggs .gs_or_ggsm a@href",
      "meta":   "div.gs_a",
      "cited":  ".gs_fl a.gs_or_cited"
  }}
]})
```

`type` with a `selector` focuses the element first, so no extra `click` is needed. **It also
selects-all and clears first**: if it cannot clear, it errors and types nothing — so reusing a
box that already has content can hit `browser.target_unusable`, which is not a bad selector.

**The playbook extracts only the fields you need to judge relevance** (`SKILL.md` §4). The abstract
snippet is in the "Result-page fields" table — extract it once you have picked papers.

**Click the submit button; do not rely on Enter.** In the first release's reconnaissance,
pressing Enter in the input did not submit (same on Baidu Xueshu). There is a candidate
explanation (CDP's `keyDown` only produces a char event when it carries `text`, and this
project's key table does give `Enter` a `text`), **but this project has never measured it** —
until it is re-verified, always click the button. Clicking also works on sites whose submit
control is not a `type=submit`, and it is the only path measured to work.

**Do not click again right after submitting.** Scholar is most sensitive to rapid repeated
actions, and that extra click is exactly the shape of falling into a 403. After submitting,
first look for a navigation verdict in this return value; if there is none, check the
`导航: [tab_…]` line in the header of the next call.

Acceptance groups 3 and 5 each hit this once on 2026-09-17: after the first click on submit, the
address stayed unchanged for 8–15 seconds. Reproduced the same day in a fresh session, the click
landed on `#gs_hdr_tsb` and did submit — the navigation just arrived **after** the tool had
returned (onto the 429 verification page from ①). So:

1. If you see no navigation verdict after clicking, call `browser_tabs` first — a late navigation
   hangs on the `导航: [tab_…]` line in its header;
2. If the address really is still the home page, **click once more, and only once**;
3. If it still does not move after that, hand it to the user with `browserTabId`, offering "skip
   Scholar". **Do not fall back to building a `scholar?q=…` URL** (the field names in §② "are not
   for constructing URLs").

**Do not judge this by the "requests sent" section.** Scholar's home-page submit is a whole-page
navigation, not XHR / fetch: that section saying 「没有发出任何」 is normal here and **does not mean the
click was missed**. The only signal is the navigation outcome — the three steps above.

**Never write `index` into a playbook.** Snapshot indices are a product of this one page view
and drift with the session; `index` is for exploration only (clicking what you see in a
snapshot), and once explored it always becomes a `selector`.

### Result-page fields (hit counts measured 2026-09-16)

Results page URL is `https://scholar.google.com/scholar?q=<terms>&hl=<lang>&as_sdt=0,5`,
**10 per page**. Item container `.gs_r.gs_or.gs_scl` (10/10 measured).

| Field | Selector | Notes |
| --- | --- | --- |
| Title | `h3.gs_rt a` | 10/10 |
| Paper page | `h3.gs_rt a@href` | The publisher's or preprint's landing page, e.g. `arxiv.org/abs/2210.02747` |
| **Direct PDF link** | `div.gs_ggs .gs_or_ggsm a@href` | The block on the right, 10/10 this run. **Not every record has one**, and it correlates strongly with the query |
| PDF source label | `div.gs_ggs .gs_or_ggsm a` | Text like `[PDF] arxiv.org`, `[PDF] openreview.net` |
| Authors/venue/year | `div.gs_a` | One whole line, like `Y Lipman, RTQ Chen… - arXiv…` |
| Abstract snippet | `div.gs_rs` | |
| Citation count | `.gs_fl a.gs_or_cited` | 10/10. Text like 「被引用次数：7347」; href is `/scholar?cites=<clusterId>` |
| All versions | `.gs_fl a[href*="cluster="]` | Text like 「所有 N 个版本」 |
| Related articles | `.gs_fl a[href*="related:"]` | |
| Cached HTML | `.gs_fl a.gs_or_nvi` | Only when a cache exists |

The 「保存」 and 「引用」 anchors inside `.gs_fl` have `javascript:void(0)` hrefs — **they are
not links, do not take their href**.

### Paging (measured working 2026-09-16)

The paging strip is `#gs_n` and contains **real `<a href>`s**. The current page is a `<b>` with
no link.

Use **`#gs_n a:has(.gs_ico_nav_next)`** for "next" — measured to match **exactly 1**, and it
**does not depend on the interface language**. Do not match the label text.

**Use the offset in the address as the wait condition**: that link's href is
`/scholar?start=10&…`; after clicking, the URL becomes `start=10`, and page 3 is `start=20`
(`start = (page − 1) × 10`). It differs per page and does not hold before the click, which is
exactly the shape `wait` needs; `urlMatches` is judged against the main process's own address
and never enters the page.

One page per `browser_act`, **never inside a `repeat`** — every round of a batch shares one
wait condition, while "which page am I on" differs per page.

```jsonc
// Turn to page 2 and extract it (for page 3, swap start=10 for start=20)
browser_act({ tabId: "<the same tabId>", actions: [
  { "kind": "click", "selector": "#gs_n a:has(.gs_ico_nav_next)" },
  { "kind": "wait",  "until": { "urlMatches": "start=10" } },
  { "kind": "extract", "selectors": { "item": ".gs_r.gs_or.gs_scl", "title": "h3.gs_rt a",
      "page": "h3.gs_rt a@href", "pdf": "div.gs_ggs .gs_or_ggsm a@href", "meta": "div.gs_a",
      "cited": ".gs_fl a.gs_or_cited" }}
]})
```

The paging click is a plain link, so `browser_act` already waits for the main frame's definite
navigation terminal state — the `wait` above is not there to wait for navigation, it is there
to tell **page 2 from page 3** (a navigation terminal state cannot prove which page you landed on).

On the last page that `click` errors because nothing matches — expected behaviour, and every
earlier page's rows are already in their own call's return value.

**Do not page too far.** Scholar is far more sensitive to rapid repeated paging than to a
single search, and falling into a 403 mid-way costs you the whole source (falling into the 429
verification page can be handed to a person to solve; see ①).

---

## ④ Action · getting access

**Public, no login.**

**The 403 and the 429 are both anti-bot defence, not an access problem.** Do not read them as
"you must log in" — the first release measured that signing in to a Google account is still 403.
Handling is in ①: on a 403 switch source and do not call the user; hand a 429 verification page
to the user to solve.

---

## ⑤ Action · detail page

**This source has no detail page.** `h3.gs_rt a@href` points straight at the publisher's or
preprint's landing page, with no Scholar-side intermediate page.

So "see the details" means opening that landing page (`browser_open` + `browser_read`), and
that is **a different site** — which kind of source it is and whether it needs access rights
gets judged again from `SKILL.md` §2.

Two Scholar-side aggregate pages are worth knowing, to open only when needed; **both count
against the paging budget**:

- "All versions" `.gs_fl a[href*="cluster="]` — every copy of the same paper, useful when
  hunting for an open one
- "Cited by" `.gs_fl a.gs_or_cited` — the list of citing works; same page structure as a normal
  results page

---

## ⑥ Action · getting the full text

**This source hosts no full text; it points at where to get it.** When you actually need to
read the full text, take one of the two routes below (the rules live in `SKILL.md` §5);
downloads the page triggers itself are still cancelled outright.

`div.gs_ggs .gs_or_ggsm a@href` is this source's most valuable cell — it points straight at an
open copy. Measured targets include `arxiv.org/pdf/…`, `iclr.cc`, `neurips.cc`,
`openreview.net`. Extracting nothing means that record has no open copy, not that the
selector is broken.

- **The direct link or the paper page points at arXiv / PMC / DOI** → hand the identifier to
  `fastpaper download`. It routes by identifier and is far cheaper than the browser.
- **Any other bare PDF URL** (`openreview.net/pdf?id=…` and the like) → `browser_download`:
  pass the extracted link verbatim as `url`, with this Scholar tab as `tabId`. fastpaper
  accepts only bare identifiers and rejects URLs outright.

`browser.download_not_pdf` means that address did not return a PDF in the current session (a
block page, a landing page) — **we failed to get it; it does not mean the paper has no full
text**. Report the link to the user verbatim.

---

## ⑦ When you must hand over to a human

- **The 429 verification page** (snapshot shows `presentation "reCAPTCHA"`) — hand it over with `browserTabId`, and do not resubmit once it is solved (①)
- **Not for the 403 hard wall** — a human cannot clear it either; switch source (①)
- Otherwise follow the hand-over rules in `references/browser.md`

---

## ⑧ Known limits

- No official API; strong anti-bot defence, and the search action draws an outright 403, or a
  429 verification page, on egresses judged to be automated
- Mainland China usually needs a proxy to reach it
- Citation counts are Scholar's own measure and disagree with Web of Science / Scopus —
  **do not report them as authoritative**
- No detail page; the only metadata is the single `div.gs_a` line on the results page
  (authors, venue and year crammed together, with no separate fields)
- The interface language follows the browser, so **any selector that matches label text is
  unreliable**
