---
name: literature-review
description: Search the literature on one topic (or one paper) across multiple rounds, keywords and sources — reviews first, then citation chains traced back to the classics, results organized into a literature map — and produce one file whose front half is review prose ready to paste straight into a paper's Related Work / state-of-the-art section (author-year citations + reference list), and whose back half is the full report on searching, verification and insight. Use this skill when the user says they want to write a review, write a state-of-the-art section, map out a direction, wants to know how far a field has got by now, needs related work filled in for a paper, or asks "which are the important papers in this direction". Beyond just listing papers it separates foundational work, existing reviews, mainstream lines, consensus and controversy, and the latest progress; every paper is verified back at its source; and it says where it differs from the reviews that already exist.
---

# Literature Review

The deliverable is **one Markdown file** in two parts:

1. **The review prose** (first) — continuous prose you can paste into a paper as a block, author-year inline citations + a reference list at the end.
2. **The review report** (after it) — the search process, the literature map, the verification outcome, the review-level insights.

The prose goes first so that you can select from the top of the file down to the horizontal rule and paste it straight out, without picking it out of the report by hand.

**Write in the language the user speaks.** They ask in Chinese, you produce Chinese; they ask in English, you produce English — prose, report and section headings all follow. Paper titles in the reference list keep their original language, do not translate them.

## Before starting

1. `date +%F` — the file name needs it.
2. **read fastpaper's SKILL.md** (it is in `<available_skills>`). Search syntax and filter support differ from source to source, and guessing a flag from memory silently gets you wrong results.
3. `ls papers/` — there may already be papers on hand.
4. **Confirm the topic.** Did the user give a one-sentence topic, a direction, or a paper? If a paper, first `fastpaper get <id>` to fetch it and use its title, abstract and reference list as the starting point for searching. If the topic is too broad ("applications of artificial intelligence in medicine"), ask in ordinary conversation which layer they want covered, do not pick one yourself.

## Ask about length

Before searching starts, use `ask_user_question` once to ask which length tier (**must be a call on its own**, cannot be batched with other tools):

| Tier | Words | Where it goes |
|---|---|---|
| Short | 500–750 | Related Work in a conference paper |
| Medium | 1200–1800 | the state of the art in a journal paper |
| Long | 2400–3600 | the state-of-the-art chapter of a thesis |

Ask this one question only. Length decides how wide the search has to spread — a long review needs 25–35 papers in the prose, a short one is fine with 12–18, and asking first is far less work than searching and then deleting.

## How to run the search commands

Everything in AGENTS.md's "how to use tools" applies: one fastpaper command per bash call, read stdout directly, do not create directories, do not write intermediate files (`-o` included), do not merge with scripts. For several queries use **several parallel calls**, not a shell loop.

Only two things should go to disk: the PDFs in `papers/`, and that final file.

**Output format**: for triage, scanning titles, use the **default table** (`-n 8` is about 1.8k characters, with id/title/year/authors); reach for `--format json` only when you need to compare fields exactly (same number of records, ~20k, 11×). Leaving json on for a whole round is the fastest way to burn through the context.

---

## Step 1: Search

The full search tactics, the capability differences between sources, and the traps that must be avoided are in `references/search-strategy.md` — **read it before you start**. This section gives only the order and the reasons.

**Only B genuinely depends on A** — you need the reviews before you can intersect their reference lists. Finding the latest progress depends on no earlier result, so it does not queue up and wait:

```
A  find reviews                                        ┐
                                                       ├── start in parallel
C1 latest progress, round 1 (topic terms + preprints)  ┘
     ↓
B  trace the classics back through citation chains (depends on A)
     ↓
C2 latest progress, round 2 (search on new terms absent from A/B + cite incoming)
     ↓
D  citation heat and gap filling
```

**Why not cast a wide net over topic terms right away**: you drown in a few hundred moderately relevant hits, and you cannot tell which ones are genuinely classics — classics are recognizable only through the citation-chain intersection in B. But that is no reason to make the latest progress wait in line.

**C is split into two rounds because vocabulary changes.** C1 uses the words the user gave; C2 uses the words you only learn after reading A and B — especially the **new terms that never appear in the reviews**. If a subfield that has just taken off renamed itself, the old reviews' words will never find it.

> **Two lines, independent of each other.** A+B build the **consensus map** (what the acknowledged canon of this direction is), C finds the **frontier**.
> A review is by definition what has settled; it does not tell you where the frontier is, and using reviews to define "what counts as new" puts the cart before the horse.

### A. Find the reviews first

Reviews are the entrance to the consensus map. A good review from the past three years has already done the sorting of classics for you, and its reference list is made of **real citation edges**, more reliable than any relevance ranking.

Target: 2–4 reviews / commentaries / progress pieces from the past 3 years. If nothing from the past three years turns up, widen the window and say so in the report — a direction nobody has reviewed for years is itself a signal worth writing into the insights.

### B. Trace the classics back from the reviews

```bash
fastpaper cite <review DOI> --direction outgoing -n 30
```

That gives you its reference list. **Intersect the reference lists of several reviews** — whatever several independent reviews cite over and over is the acknowledged classic of this topic.

This route is far more reliable than sorting by citation count. Measured: `--sort citations` on `crossref` and `openalex` goes badly off topic — searching "wearable ECG myocardial infarction" returns INTERHEART, the ESC guidelines, UK Biobank, the giants of the whole discipline, unrelated to the topic. Only `semantic` held on to topical relevance. **"Highly cited" is a proxy, "cited over and over by the reviews of this topic" is the fact.**

**But recognize its blind spot: citation chains can only find work connected to the existing canon.** The genuinely new entrants are often disconnected — people carrying a method in from another discipline cite the canon of their own side; a new subfield that switched terminology matches neither on keywords nor on citations; many preprints and industry papers never enter the citation network at all. So **stage C must not depend on citation chains**, it needs an entrance of its own.

### C. Latest progress (two rounds, C1 parallel to A)

Reviews have a cutoff date, and nobody has organized what came after it for you. **The number of queries at this stage must not be fewer than at stage A** — it is the only source of whatever makes this review newer than the reviews that already exist.

**The time anchor is today, not the review.** Always `--after <this year minus 2>-01-01`. Taking "the year of the newest review" as the starting point is wrong: when the reviews stop at 2019, `--after 2019` drags back six years of material and the real frontier drowns in it.

**C1 (parallel to A, does not wait)** — three entrances, none of them depending on citation chains:

1. The topic terms the user gave, past two years
2. Preprints `biorxiv` `medrxiv` `arxiv` — by definition they cannot be in any published review
3. **Cross-discipline sources**: search `arxiv` for a biomedical topic too (`--field eess.SP` `cs.LG`), and search `pubmed` `europepmc` for a CS topic too. Measured effective — the same ECG topic finds 2025–2026 work on arxiv whose authors are signal-processing and machine-learning people citing the canon of their own side, and the citation network of the PubMed reviews contains none of them

**C2 (after A/B)**:
- From the new papers read in C1 and B, pick out the **terms that never appeared in the reviews** and search again with them
- Run a round on **problem words** rather than only technical words — new entrants use their own method vocabulary but describe the same problem
- `fastpaper cite <a new paper from the past two years> --direction incoming` — note this is done on the **new papers**, not on the classics

**Two hard checks**:

1. **C found not one piece of work later than the newest review** → you must not just write "no latest progress found". Either the direction really has stalled (a conclusion that belongs in the insights), or the search terms are out of date. Run another round with a different set of terms, and say in the report which of the two it is.
2. **If every one of the frontier papers can be connected to B's classics by a citation edge** → the disconnected ones were not found. Run at least one more round each on cross-discipline sources and preprints.

### D. Citation heat and gap filling

**Total historical citations can be had directly**: the json from `openalex` / `semantic` carries a `citations` field. To sort by it, use `--sort citations` on `semantic` only, **do not use it that way on crossref / openalex**.

**"Recent citation growth rate" cannot be computed, do not force it.** `cite` has no `--sort` and no date filter, it can only truncate; measured on one paper (280 citations in total), the share of citations from the past year came out at 28% / 43% / 56% under `-n 25 / 60 / 120` — **the distribution drifts with `-n`**, so what you compute is the parameter you typed, not the paper's heat.

To answer "what is heating up", use this instead:

```bash
fastpaper search semantic "<topic>" --after <the year before last>-01-01 --sort citations -n 10
```

Published recently and already accumulating citations is itself a signal. In the report call it honestly what it is, **"work published in the past N years that ranks high on citation count"**; do not write it as "fastest growth in citations" — that is something you never measured.

### Keep count as you search

How many queries were run per source, how many hits, how many left after deduplication, how many selected for verification. The funnel line at the top of the report needs them, and **you cannot reconstruct them afterwards, so record them on the spot**:

> sources N1 → queries N2 → hits N3 → after dedup N4 → **selected for verification N5** → into the prose N6;
> full texts = **newly downloaded this round D1** (the difference between the two `ls papers/` runs in step 4) + **already in `papers/` D3** = N8

Check once when you are done: `N3 ≥ N4 ≥ N5 ≥ N6`, `N8 = D1 + D3`, `N8 ≤ N5`.

---

## Step 2: The literature map

Six sections, use these names directly in the report. Keep an empty section too, stating "not found" and what was searched.

| Section | What goes in it |
|---|---|
| **Foundations and classics** | Where this direction came from. Derived from the citation-chain intersection in stage B, noting how many reviews cite each one in common |
| **Existing reviews and commentaries** | What others have already summarized, what year each one covers up to, whether they disagree with one another. **This section is specific to a literature review** |
| **Mainstream lines and schools** | Grouped by technical line / methodological school, each group stating its underlying assumptions and its boundary of applicability |
| **Consensus and controversy** | Consensus one item per line; controversies written **in pairs**, who against whom and where the disagreement may come from |
| **Latest progress** | The past 2–3 years, especially what came after the newest review's cutoff. Mark which ones are still preprints |
| **Gaps and opportunities** | What nobody has done, or has not done enough of. Specific enough to be falsified in one sentence |

The "Existing reviews and commentaries" section is the easiest one to overlook, but it decides whether this review of yours has any reason to exist: **if a 2025 review already covers the same scope, you have to say clearly what you added** — the progress since it, a different organizing angle, or a branch it did not cover. If you cannot say, admit that in the insights.

## Step 3: Verification

Every paper and every claim in the map has to point back to a real source. A fabricated review is worse than no review, because it looks credible and it will be copied into a paper verbatim.

**Existence + metadata**: `fastpaper get <id>` on every paper, comparing title, year, first author, journal.

- Not findable → delete it
- Does not match what you wrote → correct it to the source, or delete it
- **The two sources contradict each other** → present both side by side with a note, do not pick one on your own authority

**Claims**: every concrete conclusion written into the prose (a number, a method, the direction of a finding) has to point to the original text. `fastpaper read papers/<file>.pdf --section results --max-length 4000` pins down the section and compares against the original. Read only the sections you need.

If you are unsure which sections exist, run `--list-sections` first. To find a particular statement in the full text ("what limitation did the authors admit", "in what context does a number appear"), use `--grep "<regex>" --context 500 --max-matches 10` — **do not dump the whole text out and read through it yourself**. Where the full text is unavailable, fall back to the abstract and mark **in the report** which claims rest on the abstract only — note that the prose carries no such mark, because the prose is going to be pasted into a paper and cannot carry one.

**Keep two sets of counts as you verify**: at the paper level (how many verified / how many into the prose / how many dropped and why / how many metadata corrections); at the claim level (how many checked / how many compared against the full text / how many abstract-only / how many corrected or deleted).

## Step 4: Downloads

**Run `ls papers/` once more before writing the report** and take the difference from the one at the start; that is this round's new D1. Do not count from memory how many download commands you issued — with source switches and failures followed by successes, memory always gets it wrong.

File name rule: the `/` in a DOI becomes `_`, arXiv ids and PMC ids as they are.

Download failures are common (paywalls, anti-scraping, a landing page returned, no open access, source-side rate limiting, and work published this year the aggregators have not indexed yet). **Look at the exit code first**: `4` = the request was fine, this source simply does not have it, so switching sources is the only move that makes sense; `2` = the command was written wrong; `1` = something else. Outside of `4`, fastpaper's error gives the URL it tried and its judgment on whether switching sources is worth it — **copy its judgment, do not start a retry strategy of your own**. On failure, record "not obtained" in the appendix with the reason. **Do not fabricate a successful download.**

---

## Step 5: Writing the prose

The template is in `assets/report-template.md`; use `write` to write it to the **project root**, with the file name:

```
literature-review-<short-topic-name>-YYYY-MM-DD.md
```

The short topic name uses hyphen-joined English or pinyin, do not use spaces, do not use underscores, the date goes last — the same style as `research-ideation-*`, so that the deliverables under one project directory sort together by type.
**Two kinds of blockquote in the template, do not confuse them.** The ones opening with `[WRITING NOTE]` are written for you, and **the whole block (down to the blank line) stays out of the report** — not one line of it may remain. Every other `>` blockquote — currently only the count line at the top — **is part of the report**: keep it as it stands and fill in its placeholders.


Requirements for the prose part:

**It is continuous prose, not a list of papers.** The test is simple: if every paragraph reads "X et al. did A, Y et al. did B, Z et al. did C", that is a list, not a review. A review has to **organize the papers into an argument** — grouped by line, pointing out the premise they share, saying who solved whose problem, and where they still disagree.

**Citation format**: within the prose use 「作者 等（年份）」 or (Author et al., year), following the language of the prose; the reference list at the end goes in alphabetical order by first author, each entry with a complete bibliographic record and a DOI.

**These must not appear**: the `[abstract only]` mark, "this report", "we searched", cross-references to sections ("see section two"), any meta-information. The prose is going to be pasted into someone else's paper, and anything like that has to be deleted by hand.

**End on the gaps.** The function of a review chapter is to make room for your own work — the final paragraph has to say how far the existing work goes and what is still missing. That paragraph is often the most cited one in the whole piece.

**Every sentence needs a source.** Delete generalizations with no literature behind them ("this field has developed rapidly in recent years"); they carry zero information for the reader, and they will draw a request for citations in review.

## Step 6: Writing the report

Besides the literature map, the report part needs one section of **review-level insights** — this is where your review adds value, and it is not a restatement of the map:

| Subsection | What it has to answer |
|---|---|
| **The line of development** | Why it came along in this order, and what problem of the previous step each step solved |
| **The assumptions behind the main technical lines** | What assumptions each line is built on, and which assumption has the thinnest evidence |
| **Where existing reviews disagree and what that points to** | What unsolved problem of the field the inconsistencies between reviews point to |
| **Bottlenecks and a read on the trend** | Which line may be limited by which bottleneck, and which direction's preconditions are ripening |

This section is allowed judgment and speculation, but **every judgment has to hang on a specific paper**, and it has to distinguish clearly between "what the literature says" and "my inference".

---

## Honesty boundaries

- **"Most downloaded" cannot be had.** Not one of fastpaper's 18 sources provides download counts, only citation counts. Do not pass off another metric as it, and do not say vague things like "widely noticed".
- **Citation counts exist only on `semantic` and `openalex`**; any other judgment of "importance" is a proxy, and if you use one, mark it. There is no impact factor.
- **Not found ≠ does not exist.** State on which sources and with which terms it was not found.
- **Not a single id may be invented.** Every DOI in the prose and in the reference list must have been confirmed back at the source with `fastpaper get`. If you cannot, do not write that entry — the prose gets copied into a paper verbatim, and one fake DOI is an academic incident.
- **Pure Markdown only, no HTML tags.** KyDog's renderer is ReactMarkdown + remark-gfm with no rehype-raw, so things like `<details>` show up verbatim.
