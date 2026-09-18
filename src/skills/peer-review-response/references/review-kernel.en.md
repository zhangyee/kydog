# The Review Kernel

Three steps: **neutral mapping → overall judgment → itemized checks**. This procedure is shared by `/peer-review` (self-review) and `/peer-review-response` (reviewing others) — each skill carries one copy in its `references/`, **byte-for-byte identical, pinned by a unit test**; a change to this file must be made in both copies, with no solo improvisation on either side.

## Step 1: Neutral mapping

First survey the manuscript without taking a position: research question, subjects/data, design, and every core claim (record the verbatim quotes). Describe only; judge nothing.

This step anchors every criticism that follows — criticizing a version you imagined instead of the one on the page is the most embarrassing way a review fails. The claim list matters most: every concern in Step 3 must point back to one of these claims or one link of the chain.

## Step 2: The whole, before any itemized concern

Two questions, in order:

1. **Is the argument chain intact?** Hypothesis → design → analysis → results → conclusions, link by link. A design that cannot test the hypothesis, conclusions that outrun the results — name the exact link where the chain breaks.
2. **Does the claimed contribution hold?** Check the claimed novelty against a search (table format) for the closest prior work. How many queries is your call, on a single criterion: **enough to name the closest prior work, or to establish that none was found** — this is a targeted search in service of the novelty judgment, not a survey; sweeping the field is `/literature-review`'s job. "This has been done before" must point to a specific paper confirmed by search; saying it from impression is saying nothing.

   Originality lands in the overall judgment as three checkable statements: **which layer the novelty sits on** (conceptual / methodological / engineering / application); **what the delta over the closest prior work is** — a gap statement falsifiable in one sentence ("they only did X; this manuscript does Y"; "deeper" or "more systematic", true of any paper, does not count); **whether that delta carries enough weight for the target venue** — weight is relative to a journal or conference, so ask the user when the venue is unclear; without a venue there is no verdict.

When the whole has a fatal problem — the chain is broken, the contribution has already been done, the structure needs rebuilding — **say plainly in the report that "this manuscript is not yet at the stage of itemized review"**, concentrate the evidence on the global problem, and do not lay out thirty small comments on top of it. A short review that names the fundamental problem is worth far more to the authors than a long list that buries it.

## Step 3: Itemized checks

Go through as passes, one question per pass:

- **Methods and statistics**: criteria follow the manuscript's type; no dogma — do not mechanically say "n<30 is too small" or "Bonferroni is required"; a comment only counts if you can state the consequence. Keep the four kinds apart: **not reported** (not enough information — goes to "could not assess") ≠ **design concern** (the reported method may not answer the question) ≠ **internal contradiction** (two places in the manuscript disagree — quote both side by side) ≠ **integrity concern** (describe neutrally and suggest the user route it through the editor's confidential channel; no accusations).
- **Causal language**: catch every causal word the design cannot carry — cross-sectional data with "predicts / causes" is a concern, each time.
- **Numbers vs. interpretation**: could the same results tell the opposite story? Does every mechanism claim have a corresponding measurement? An effect barely apart written up as "significantly outperforms" — every gap between claim and evidence counts.
- **Literature**: both directions go back to the source. Missing work → confirm by search that the paper exists and is on point; citation spot-check → pick the **load-bearing** citations and verify them at the source. How many is your call, on a single criterion: **if this citation collapses, does it take a concern or a key claim of the manuscript down with it**. Verification has two tiers, next section. Pick sources for the missing-work search per AGENTS.md's "Looking for Papers": when the manuscript is in Chinese or studies something in China, **Baidu Xueshu must be searched**; this is a targeted search, so the volume follows slowpaper's representative tier.
- **Figures and tables**: the tools cannot see figures. Judge what can be judged from captions and the text; what cannot be judged **goes to "could not assess"** — neither forced verdicts nor silence.
- **Writing**: last and lightest. Inconsistent terminology and confused structure are worth writing; style preferences are not.

### Two tiers of citation verification

The default is the **abstract tier**: `fastpaper get <id>` — existence, topical relevance, direction of the conclusion; background and existence-type citations need no more.

Two situations **must escalate to the full-text tier** (`fastpaper download <id> -d papers/`, then `fastpaper read --grep` to the passage):

1. The manuscript hangs **specific numbers, quotes, subgroup findings, or method details** on the citation — abstracts do not contain these, so an abstract-tier check checks nothing.
2. You are about to write **"this citation does not support the claim"** — an accusation-grade judgment that the authors miscited; it must be verified against the full text. When the full text cannot be obtained, downgrade the wording ("the abstract shows no support; the full text could not be obtained for verification") — never write it in the voice of a full-text check.

When a download fails, read the exit code first (`4` = this source simply does not have it, so switching sources is the only move that means anything); if the full text stays out of reach, fall back to the abstract tier and say so. **Judgments verified only against an abstract carry `[abstract only]` in their Basis line**; the report's limitations/boundaries section states which tier the citation checks reached, and how far the Chinese-language side was searched.

**Citations with no identifier** (Chinese journal articles, theses) cannot be traced back with `fastpaper get`; the two tiers still apply, only the place of checking changes:

- **Abstract tier**: check the record on Baidu Xueshu — title, authors, venue, and year match what the manuscript cites. Checked only as far as the record, tag it `[record only]`; checked against an abstract on the detail page, tag it `[abstract only]`.
- **Full-text tier**: find the full-text entry on the detail page or the publishing platform and fetch it with the built-in browser (`browser_download`). No downloads from subscription databases reached through an institutional login; when the full text stays out of reach, downgrade the wording per point 2 above.
- **Not found is not "does not exist"**: write "not found on 〈source〉 with these terms", never "this reference does not exist" — the latter accuses the authors of inventing a citation.

## Severity (criteria fixed; no hedging)

| Level | Criterion |
|---|---|
| **Major** | Unresolved, the central conclusion does not stand — or a substantive flaw in methods or statistics. **A specific defect must be nameable**: which control is missing, which step overreaches causally, which search-confirmed paper is absent. "It feels shallow" is not a Major. |
| **Minor** | Local; better fixed, but the central conclusion stands without it. |
| **Could not assess** | Things the material does not contain (figures, data, supplements). **Flag them; do not book them as defects** — "not reported" and "flawed" are different things. |

**No quotas**: a tier with nothing gets "none identified" — never pad for the appearance of thoroughness or balance. **More than 8 Majors** means the disease is upstream — go back to Step 2 and fold them into the overall judgment.

## The five elements of every concern

- **Location**: section name + verbatim quote (20 words or fewer)
- **Problem**: one or two sentences, stating fact
- **Why it matters**: what it means for the conclusion or the reader
- **Suggestion**: executable — "add the X control", "change 'causes' to 'is associated with'" — not "strengthen this"
- **Basis**: methodological points carry a full, source-verified reference; the obvious may go without

Number concerns with **one global sequence**: Majors from 1, Minors continuing the count (Majors 1–5 means Minors start at 6). Severity is carried by the section headings and each item's label, **never encoded in the number** — the academic convention is that numbers locate and sections rank; cite an item as "comment N".

**Every reference the review itself cites must be listed together at the end of the report**: Author (year), Full Title, DOI, all verified at the source — a referee has to produce evidence too, and the authors must be able to check it. Citing in the body without listing at the end makes the review sloppy. If nothing was cited, say "no external literature was cited".
