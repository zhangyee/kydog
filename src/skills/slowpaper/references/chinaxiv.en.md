# ChinaXiv · operations card

The Chinese Academy of Sciences' preprint platform, China's only authoritative preprint
repository. **It has real direct download links.**
Axis-A kind 2. Shared discipline is in `SKILL.md` §5 and §6.

> **Reconnaissance: measured on the live site 2026-09-16** (viewport 1280); every selector
> carries a hit count. Anything not measured says "not explored".

## ① Reachability

Stable in the browser (244 KB / 20 items measured). No Cloudflare.

> ⚠ **Plain HTTP is unreliable, so the browser is mandatory.** For the same search address, one
> curl returned 250 KB with 40 results and the next returned only **4.7 KB and 0 results**. That
> 4.7 KB stub **parses fine and yields zero** — it looks exactly like "this topic has no papers".
> **When you extract 0 rows, check the page size first; do not read it as "this source has none".**

## ② What controls the page has

The search box and submit button were **not measured separately** (this round went straight to
the results address to check structure). The results address is shaped like
`chinaxiv.org/user/search.htm?searchClassKey=&searchWord=<query>`.

## ③ Action · search

**20 per page.**

| Field | Selector | Hits |
| --- | --- | --- |
| Item container | `div.list > ul > li` | 20 |
| Title | `h3 a` | **20/20** |
| Detail page | `h3 a@href` → `/abs/202609.00156` | **20/20** |
| ChinaXiv id | `.flex_item em a` | **20/20** (text like `1. ChinaXiv:202609.00156`) |
| **Direct download** | **`a[href*="/user/download.htm"]@href`** | **20/20** |
| Subject / submitted date / authors / abstract | **no class of their own**; read them out of the `li` text | — |

**Paging is not explored** — every `pageId=` link on the page belongs to the left-hand year
filter, not to page numbers.

## ④ Action · getting access

Public, no login.

## ⑤ Action · detail page

`h3 a@href` is a real link (`/abs/<id>`), so just open it. The detail page's structure is
**not explored**.

## ⑥ Action · getting the full text

**`a[href*="/user/download.htm"]@href` is already on the results page, 20/20** — shaped like
`/user/download.htm?uuid=<uuid>`. Fetch it with `browser_download` (it goes through this tab's session); no detail-page visit is needed.

## ⑦ When you must hand over to a human

Nothing needing a hand-over came up this round.

## ⑧ Known limits

- No usable API — the OAI endpoint measured as "Sorry!You have no right to access this web."
- **Plain HTTP is intermittent**, and the stub disguises itself as "0 results" (see ①)
- Paging not explored
- Metadata is crammed into one block of text with no separate fields
