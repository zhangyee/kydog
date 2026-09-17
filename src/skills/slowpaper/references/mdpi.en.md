# MDPI · operations card

A pure-OA publisher with 400+ journals, all CC-BY. Axis-A kind 2. Shared discipline is in
`SKILL.md` §5 and §6.

> **Reconnaissance: measured on the live site 2026-09-16** (viewport 1280); every selector
> carries a hit count. Anything not measured says "not explored".

## ① Reachability

curl **403**; the browser is fine, **no Cloudflare challenge**.

It does have OAI-PMH (`oai.mdpi.com/oai/oai2.php`), but that only harvests incrementally by date
and set — **there is no keyword search** — so keyword search goes through here, not the API.

## ② What controls the page has

Results page `mdpi.com/search?q=<query>`, **50 per page** (the on-page `page_count` dropdown
changes it). The search box and submit button were **not measured separately** (this round went
straight to the results address to check structure).

## ③ Action · search

| Field | Selector | Hits |
| --- | --- | --- |
| Item container | `div.article-item` | 50 |
| Title | `a.title-link` | 50/50 |
| Detail page | `a.title-link@href`, shaped like `/2504-4990/8/9/283` | 50/50 |
| Authors | `div.authors` | 50/50 |
| Journal | `.color-grey-dark` | 50/50 |
| DOI | in-item `a[href*="doi.org"]` | 50/50 |
| **Direct PDF** | **`a.UD_Listings_ArticlePDF@href`** | **50/50** |

Paging uses real `<a href>`, **located by page number**:

```jsonc
browser_act({ tabId: "<the same tabId>", actions: [
  { "kind": "click", "selector": "a[href*=\"page_no=3&\"]" },
  { "kind": "wait",  "until": { "urlMatches": "page_no=3" } },
  { "kind": "extract", "selectors": { "item": "div.article-item", "title": "a.title-link",
      "page": "a.title-link@href", "pdf": "a.UD_Listings_ArticlePDF@href", "authors": "div.authors" }}
]})
```

> ⚠ `a[href*="page_no=2&"]` matches **2** (the "2" link and the next-page chevron, both going to
> page 2); `page_no=3&` matches 1. In-page resolution uses `querySelector` and takes the first, so
> it works — but **which page you landed on is judged by `urlMatches`, never by the hit count**.

## ④ Action · getting access

Public, no login.

## ⑤ Action · detail page

`a.title-link@href` is a real link, so just open it. The detail page's structure is
**not explored** (this round did not go in).

## ⑥ Action · getting the full text

**`a.UD_Listings_ArticlePDF@href` is already on the results page, 50/50** — the cleanest cell in
this batch of OA sources, and no detail-page visit is needed. It is shaped like
`/2504-4990/8/9/283/pdf?version=…`; fetch it with `browser_download` (it goes through this tab's session).

## ⑦ When you must hand over to a human

Nothing needing a hand-over came up this round.

## ⑧ Known limits

- No usable search API (OAI-PMH only harvests by date)
- curl cannot reach it (403), so the browser is the only path
- Search box / submit button and the detail-page structure are **not explored**
