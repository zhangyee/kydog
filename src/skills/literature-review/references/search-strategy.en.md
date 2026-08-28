# Search Tactics

Goes with Step 1 of SKILL.md. Prerequisite: fastpaper's SKILL.md has been read.

**These are two independent lines, not one pipeline.**

- **A + B build the consensus map**: what the acknowledged canon of this direction is. Through the reviews and the intersection of their citation chains.
- **C finds the frontier**: what is happening lately. **It depends on no product of A or B.**

Merging them into one line is a common mistake, and the consequence is that the frontier ends up defined by the reviews. A review is by definition what has **settled** — its search cutoff is often a year earlier than its publication year — it tells you what has become consensus, not what is happening.

There is only one real dependency between the stages: B needs A's results. So **A and C1 start in parallel**, and C2 runs after B.

Casting a wide net over topic terms first is a bad move — you drown in a few hundred moderately relevant hits and cannot tell which ones are genuinely classics. But that is a constraint on "finding the canon", not a reason to make the frontier wait in line.

### The blind spot of citation chains

B and `cite --direction incoming` are both built on citation edges, so **structurally they can only find work connected to the existing canon**. Citation chains cannot see a single paper of the disconnected kinds below:

| Kind of disconnection | Why it is disconnected |
|---|---|
| People carrying a method in from another discipline | They cite the canon of **their own field**, not the one here |
| A new subfield that switched terminology | Neither the keywords nor the citations match |
| Preprints, industry work | Many never enter the citation network at all |
| Just published | Not cited yet, and too late to cite the newest work |

So C must have an **entrance that does not go through citation chains**. See the three under C1 below.

---

## A. Finding reviews

### Filter by publication type (most accurate)

`pubmed` and `pmc` pass the query through verbatim, so their `[pt]` field is available:

```bash
fastpaper search pubmed "<topic> AND review[pt]" -n 10
fastpaper search pubmed "<topic> AND systematic review[pt]" -n 10
fastpaper search pubmed "<topic> AND meta-analysis[pt]" -n 10
```

The three have to be searched separately, they are different things: `review` is a narrative review, `systematic review` has a pre-registered search protocol, `meta-analysis` has a pooled statistic. **Distinguish them in the report** — the weight of a meta-analysis's conclusion is nothing like that of a narrative review.

### Filter by title words (works on any source)

Sources that do not pass field syntax through (crossref, openalex, semantic) rely on title words:

```
review · survey · "a review of" · "advances in" · "progress in"
perspective · commentary · "state of the art" · "current status" · outlook
```

For the Chinese-language source (`xueshu`): 综述、述评、进展、研究现状、展望.

### Time window

Search the past 3 years first. If nothing turns up, widen step by step to 5 years, then 8, **and write in the report which year you widened to**. A direction nobody has reviewed for years is itself a signal: either it is obscure, or it is changing so fast that nobody dares summarize it, and the two cases mean entirely different things to the reader.

### Stop when it is enough

2–4 high-quality reviews are enough to move into stage B. Turning up a dozen reviews is a waste — they overlap heavily, and the extra ones show no increment in the stage-B intersection.

---

## B. Tracing the classics back from the reviews

**This is the core mechanism of the whole skill.**

```bash
fastpaper cite <review DOI> --direction outgoing -n 30
```

That returns the paper's reference list. Run it once for each review found in stage A, then **intersect them**.

- Cited by all 3 reviews → the acknowledged foundational work of this topic
- Cited by 2 → important work
- Cited by only 1 → possibly that review's particular angle, not necessarily consensus

In the report, note for each classic **how many reviews cite it in common**. That number is a protocol-level fact (a real citation edge), and it says more about its standing within **this topic** than "cited 12000 times" does.

### Why not use `--sort citations` to find the classics

Measured (v0.3.3). The same query `wearable ECG myocardial infarction`, sorted by citations:

| Source | Top few returned | Verdict |
|---|---|---|
| `crossref` | INTERHEART, the 2017 ESC guidelines, MADIT-II, the CARE trial | all off topic |
| `openalex` | UK Biobank, heart-failure guidelines ×2, atrial-fibrillation guidelines | all off topic |
| `semantic` | multi-lead MI classification, AI detection, wearable cardiac monitoring | held the topic |
| `pubmed` | `Error: pubmed cannot sort by citations` | unsupported, errors out, never silent |

When crossref and openalex sort by citations, the relevance weight gets overwhelmed and what comes back are the giants of **the whole discipline**. So:

- **Use `--sort citations` on `semantic` only**, and as gap filling, not as the main route
- **Never use it that way on crossref / openalex**
- `pubmed` raises an explicit error, so there is nothing to worry about

---

## C. Latest progress (two rounds)

Reviews have a cutoff date, and nobody has organized what came after it for you. **The number of queries at this stage must not be fewer than at A** — it is the only source of whatever makes this review newer than the reviews that already exist.

**The time anchor is today, not the review.** Always `--after <this year minus 2>-01-01`. Taking "the year of the newest review" as the starting point is wrong — when the reviews stop at 2019, `--after 2019` drags back six years of material and the real frontier drowns in it.

### C1 — parallel to A, waits for nobody

Three entrances, none of them going through citation chains:

```bash
# 1. Topic terms, past two years
fastpaper search pubmed "<the topic terms the user gave>" --after <this year minus 2>-01-01 -n 10

# 2. Preprints — by definition they cannot appear in any published review
fastpaper search biorxiv "<topic>" -n 8
fastpaper search medrxiv "<topic>" -n 8

# 3. Cross-discipline sources — a search inside this discipline never sees them
fastpaper search arxiv "<topic>" --field eess.SP --after <this year minus 2>-01-01 -n 8
fastpaper search arxiv "<topic>" --field cs.LG  --after <this year minus 2>-01-01 -n 8
```

Item 3 is measured effective. Take a purely clinical topic (ECG + myocardial infarction detection) to arxiv:

```
[eess.SP] Self-Alignment Learning to Improve MI Detection from Single-lead ECG    2025
[cs.LG]   ECGLight: Compute-Light Framework For Paper ECG Digitization and MI     2026
```

The authors are signal-processing and machine-learning people citing the canon of their own side, and the citation network of the PubMed reviews contains none of them. **The reverse holds too**: a CS topic has to be searched on `pubmed` and `europepmc`, where there is a great deal of work doing clinical validation with the same methods.

`dblp` finds essentially nothing on free-text searches like these (it is a bibliographic database), do not count on it.

### C2 — after A/B, search again with the new terms

**Vocabulary changes, and that is the only reason C has to be split into two rounds.** C1 used the words the user gave; after reading A's reviews and B's classics, you will see a batch of **terms that never appear in the reviews** — often that is what a newly risen subfield calls itself. Search again with them:

```bash
fastpaper search <source> "<a new term absent from the reviews>" --after <this year minus 2>-01-01 -n 8
fastpaper search <source> "<a problem word rather than a technical word>" --after <this year minus 2>-01-01 -n 8
fastpaper cite <DOI of a new paper found in C1> --direction incoming -n 20
```

**Run a round on problem words.** New entrants use their own method vocabulary but describe the same problem — search words for outcomes / applications / clinical endpoints, not only technical words.

**`cite --direction incoming` is to be run on the new papers found in C1, not on B's classics.** Run on the classics it only gets you development inside this field; run on the new papers it may pull in the batch that has just followed up on them. Note this one is still on citation chains, so it is a supplement, not an entrance.

### Hard checks

**Check 1: C found not one piece of work later than the newest review.** Two possibilities, meaning the opposite of each other:

1. The direction really has stalled — a conclusion that belongs in the insights
2. Your search terms are out of date — run another round with a different set of terms

You must change terms and try once more, then say in the report which of the two it is. Writing "no latest progress found" without doing this step treats a flaw in your own search as the state of the field.

**Check 2: can every one of the frontier papers be connected to B's classics by a citation edge?** If so, not one of the disconnected ones was found — run at least one more round each on cross-discipline sources and preprints. In a genuinely active direction, some part of the frontier always comes in from outside.

Preprints must be **marked as preprints in the prose**; the reader has a right to know a thing has not been peer reviewed.

---

## D. Citation heat and gap filling

Users often ask "which are the most cited historically" and "which are heating up lately". These are two different
quantities, and fastpaper's support for them is completely different.

### Total historical citations — can be had directly

The json from `openalex` and `semantic` carries a `citations` field:

```bash
fastpaper search openalex "<topic>" -n 8 --format json     # every record carries citations
fastpaper get <DOI> --format json                          # total citations for one paper
```

This is a protocol-level number, not an estimate. To sort by it, **use `--sort citations` on `semantic` only**
(see the measured crossref/openalex drift under "Traps that must be avoided" below).

### Recent citation growth rate — do not compute it with `cite`

`cite` has only `--direction` and `-n`, **no `--sort`, no date filter**, it can only truncate.
So the idea of "pull a batch of incoming citations and count how many of them are from the past year" looks workable but does not hold.

Measured (v0.3.3). Take a paper with 280 citations in total and pull different numbers of incoming edges for the same id:

| `-n` | 2023 | 2024 | 2025 | 2026 | 2025 share |
|---:|---:|---:|---:|---:|---:|
| 25 | 1 | 17 | 7 | 0 | **28%** |
| 60 | 5 | 29 | 26 | 0 | **43%** |
| 120 | 6 | 40 | 67 | 7 | **56%** |

**The year distribution drifts systematically with `-n`** — what comes back is neither a random sample nor a time-sorted one.
A "citation growth rate" computed from a truncated sample like this measures how large a `-n` you typed, not that paper's heat.
**Do not write numbers like that into the report.**

### The clean way to do "what is heating up"

Instead of computing a rate, **search for papers published recently that have already accumulated citations**:

```bash
fastpaper search semantic "<topic>" --after <the year before last>-01-01 --sort citations -n 10
```

A paper published in the past two years that has already taken tens of citations is itself a heating-up signal. This route uses
the CLI-validated `--after` plus sorting, never touches the sampling of citation edges, and has no truncation bias.

In the report, describe honestly what it is: **"work published in the past N years that ranks high on citation count"**,
do not write it as "the work whose citations are growing fastest" — the latter is something you never measured.

---

## Traps that must be avoided

### `CITED:>N` has no effect, use `CITED:[N TO *]`

fastpaper's SKILL.md gives `CITED:>500` as its example, but measured (v0.5.0) the `>` form is silently ignored by europepmc — thresholds of 500 and 100000 return exactly the same results. Only the Lucene range form actually filters:

```
CRISPR AND CITED:>500          → 2 hits
CRISPR AND CITED:>100000       → 2 hits   ← not filtered
CRISPR AND CITED:[500 TO *]    → 2 hits
CRISPR AND CITED:[100000 TO *] → 0 hits   ← filtered

Incremental check: CITED:[0 TO *] 20 hits → [10000 TO *] 5 hits → [50000 TO *] 1 hit
```

**Use the range form.** It is the only way to filter by citation count at the search stage (`semantic --sort citations` can only sort, it cannot set a threshold).

### General technique: re-run any filter written into the query with an extreme value

The CLI's flags (`--year` `--after` `--author`) are validated by fastpaper and raise an explicit error where unsupported. But **field syntax written into the query string** (europepmc's `CITED:` `PUB_YEAR:` `OPEN_ACCESS:`, pubmed's `[pt]` `[mh]`, dblp's `year:`) is parsed at the source, and when written wrong or unsupported it mostly **returns unfiltered results silently**.

So: **any filter condition written into a query, run it once more with an extreme value.**

```bash
fastpaper search europepmc '<topic> AND PUB_YEAR:2024' -n 3     # normal value
fastpaper search europepmc '<topic> AND PUB_YEAR:1800' -n 3     # extreme value, should return zero
```

If the extreme-value run still returns results, the condition never took effect at all. Two calls buy off a whole class of silent errors — far cheaper than finding out afterwards that the entire review rests on unfiltered results.

### Highly cited ≠ important for this topic

A paper's total citation count comes from **all** of its application settings. UK Biobank being cited a hundred thousand times does not make it a classic of wearable ECG research. Judging "important within this topic" rests on being cited by the reviews of this topic, not on the global citation count.

### The reviews themselves need verifying too

A review is the easiest thing to take as a trustworthy source and copy straight out. But its second-hand retelling may be distorted, may be out of date, may carry a position. **Key numbers in a review have to be checked back against the original paper**, especially when that number is going into your prose.

---

## Source quick reference

| Source | Publication-type filter | `--sort citations` | Good for |
|---|---|---|---|
| `pubmed` | `[pt]` ✓ most accurate | errors out (safe) | the entrance to biomedical reviews |
| `europepmc` | no reliable way | ✓ | good full-text availability, `OPEN_ACCESS:y` |
| `semantic` | none | ✓ **the only one that stays on topic** | filling in highly cited and cross-discipline work |
| `openalex` | none | ✓ but **off topic** | citation chains (`cite`'s default DOI route) |
| `crossref` | none | ✓ but **off topic** | completing bibliographic records |
| `arxiv` | none | none | CS/physics preprints, use `--field` |
| `biorxiv` `medrxiv` | none | none | biomedical preprints |
| `xueshu` | none | none | Chinese-language reviews, **serial and slow** |

`fastpaper sources --capabilities` is live, so run it once if you are unsure.
