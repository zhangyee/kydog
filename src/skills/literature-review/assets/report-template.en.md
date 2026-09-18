# Literature Review Report on <topic>

> **<N1> sources searched with <N2> queries, <N3> hits; <N4> after dedup, <N5> papers
> selected for verification, <N6> into the prose. Full-text verification used <N8> — <D1>
> newly downloaded this round, <D3> already in `papers/`.**

<date>

> [WRITING NOTE] **Every number has a locked-down definition; blur one and the whole line is worthless:**
>
> | | What it is | What it is **not** |
> |---|---|---|
> | N3 | Total records returned by all sources, cross-source duplicates included | |
> | N4 | How many remain after dedup by title/DOI | Do not report it merged with N5 into one step |
> | N5 | How many were picked out of N4 by relevance and **actually verified back at the source** | |
> | N6 | How many entered the Part One prose | |
> | D1 | How many were newly downloaded this round **and used in verification** | Not the total number of successful downloads |
> | D3 | How many of those already in `papers/` at the start were **relevant to this topic and actually read this round** | **Not the total file count of `papers/`** |
> | N8 | How many really got full-text verification this round = D1 + D3 | |
>
> **Never report the total file count of the `papers/` directory.** That directory holds papers left over from other projects,
> which mean nothing to this review, and reporting it only makes the reader think you read the entire directory.
>
> Check before you start writing: **N3 ≥ N4 ≥ N5 ≥ N6**, **N8 = D1 + D3**, **N8 ≤ N5**.

---

# Part One: The Literature Review

> [WRITING NOTE] **Everything from here down to the horizontal rule can be pasted into a paper as a block.**
>
> Hard rules: no `[abstract only]`, no "this report", no "we searched", no "see section N", no meta-information of any kind.
> Continuous prose, not a list of papers — if every paragraph reads "X et al. did A, Y et al. did B", that is a list, not a review.
> Every sentence needs a source; delete uncited generalizations like "this field has developed rapidly in recent years".
> Write in the language the user speaks. Preprints have to be marked as preprints.

## <section title, e.g. "Related Work" or "State of the Art">

> [WRITING NOTE] An opening paragraph stating what problem this direction is out to solve and why it matters. With citations.

### <subtopic 1: usually the earliest line or the most basic problem>

> [WRITING NOTE] 2–4 paragraphs per subtopic. Organized by **line / school**, not as a chronological running account.
> There has to be an argument inside a paragraph: what premise these works share, who solved whose problem, what is left unsolved.

### <subtopic 2>

### <subtopic 3>

## <section: the problems that remain>

> [WRITING NOTE] The closing paragraph. Say how far the existing work goes and what is still missing — this paragraph is what makes room for your own work,
> and it is often the most cited one in the whole piece. Be specific; "further research is still needed" is the same as writing nothing.

## References

> [WRITING NOTE] In alphabetical order by first author. Each entry gives a complete bibliographic record + DOI. Everything appearing in the prose has to be here,
> and everything here has to appear in the prose.

1. Author, A., Author, B. (Year). Title. *Journal*, Volume(Issue), pages. DOI: `10.xxxx/xxxxx`

---

# Part Two: The Review Report in Detail

> [WRITING NOTE] None of the following goes into the paper; it is how this review came about and what was read out of it.
>
> **The first time a paper appears in this part, write "Author (year), Title"**; only a repeat mention within the same section
> shortens to "Author (year)". Part One has the reference list right beside it, this part does not — with author and year alone,
> the reader cannot tell which paper it is, nor recall whether it appeared earlier. No need to repeat it where a table already has a title column.
> **The title has to be transcribed in full, do not truncate it with an ellipsis, do not shorten it yourself** — the reader is going to search with it.

## 1. What this field looks like now

> [WRITING NOTE] Three to five paragraphs of prose giving a reader unfamiliar with this direction a map: where it came from, which lines it splits into now,
> what is being argued about, where it has been heading lately. This section has to be understandable on its own.

## 2. The literature map

> [WRITING NOTE] Write the six sections in order. Keep an empty section too, stating "not found" and which keywords and which sources were searched.

### Foundations and classics

> [WRITING NOTE] Derived by intersecting the reference lists of the reviews. Note for each **how many reviews cite it in common** — that number is a protocol-level fact,
> and it says more about its standing within this topic than the global citation count does.

| Study | What it did | Reviews citing it in common | Why it is a classic |
|---|---|---:|---|
| | | | |

### Existing reviews and commentaries

> [WRITING NOTE] **This section decides whether this review of yours has any reason to exist.** For each one state: the scope covered, which year the search stops at,
> the type (narrative review / systematic review / meta-analysis — the weight of the conclusion differs completely), its position or organizing angle.

| Review | Year | Type | Scope and cutoff | Its angle |
|---|---:|---|---|---|
| | | | | |

**Where they disagree**: <if they disagree, write it out in pairs; if not, state that they are highly consistent, which is itself information>

**What this review adds**: <progress since the newest one? a different organizing angle? branches they did not cover?
If you cannot say, admit it honestly — it means the reader would do just as well reading that existing review.>

### Mainstream lines and schools

> [WRITING NOTE] Grouped by technical line / methodological school. Each group states **what assumptions it is built on**, and its boundary of applicability.

| Line | Representative work | Assumptions | Boundary of applicability and known limitations |
|---|---|---|---|
| | | | |

### Consensus and controversy

**What consensus has formed on**

- <one line per conclusion, with the supporting literature attached>

**What is still contested**

- **Point of contention: <what>**
  - One side: <paper> — <conclusion>
  - The other: <paper> — <conclusion>
  - Possible source of the disagreement: <population / measurement / statistical convention / task definition>

### Latest progress

> [WRITING NOTE] The past 2–3 years, especially what came after the newest review's cutoff. **Mark which ones are still preprints.**

### Gaps and opportunities

> [WRITING NOTE] Specific enough to be falsified in one sentence. "Validated only in mice", "longest follow-up 6 months" qualify;
> "research is still insufficient" does not, since it holds for any direction.

## 3. Literature verification outcome

All <N5> papers above were verified back at the source one by one: <N6> entered the prose, <N5−N6> were dropped for <reason>;
<M> pieces of metadata disagreed with the original record and have been corrected to the source (<name the most important one>).

At the claim level <C1> conclusions were checked: <C2> compared against the full original text, <C3> resting on the abstract alone,
<C4> corrected or deleted because the original disagreed with the draft. Full text obtained for <N8>, stored in `papers/`.

> [WRITING NOTE] **List here which conclusions rest on the abstract alone** — the prose carries no mark (that would go into the paper),
> so this is the only place the reader can find out.
> If checking a number relayed from a review back against the original paper turned up a discrepancy, it must be written here.

## 4. Review-level insights

> [WRITING NOTE] This section is where the value is added, not a restatement of the map. Judgment and speculation are allowed, but **every judgment has to hang on a specific paper**,
> and it has to distinguish clearly between "what the literature says" and "my inference".

### The line of development

<why this direction came along in this order: what problem of the previous step each step solved>

### The assumptions behind the main technical lines

<what assumptions each mainstream line is built on; which assumption has the thinnest evidence, and which work it would affect if it failed>

### Where existing reviews disagree and what that points to

<where existing reviews are inconsistent often points to a deeper unsolved problem in the field; state it too if there is no disagreement>

### Bottlenecks and a read on the trend

<which line is most likely limited by which bottleneck, and on what grounds; which direction's preconditions are ripening.
Give a judgment, do not just list possibilities — but hang every judgment on a specific paper, and mark which part is inference.>

## Appendix A: Search record

| Source | Queries | Hits | Kept after dedup |
|---|---:|---:|---:|
| | | | |
| **Total** | **N2** | **N3** | **N4** |

- Length tier: <short / medium / long>
- Review search: searched <sources> with <keywords/publication type>, found <N> reviews from the past <years> years
- Citation-chain tracing: ran `cite --direction outgoing` on each of <N> reviews, the intersection gave <N> classics
- Latest progress: reran the topic terms with `--after <year>`; preprint sources <list>; `cite --direction incoming` on <seeds>
- Filter verification: <results of re-checking query-embedded field conditions with an extreme value>

**Full-text acquisition**

<D1> were newly downloaded this round, <D2> `fastpaper download` calls failed (source-switch retries
included; D2 is the number of failures listed one by one below). Failure reasons: 403 paywall <D2a>, HTML returned instead of PDF <D2b>,
no open-access PDF <D2c>, PMC not in the OA subset <D2d>, published this year and not yet indexed by the aggregator <D2e>,
source-side rate limiting <D2f>, other <D2g>. List the verbatim error for each failure.

The <D3> already in `papers/` and actually read this round, plus the <D1> newly downloaded, make <N8> used in full-text verification.

## Appendix B: Per-paper verification record

| Paper | Title | Source check | Metadata | Basis for claims | Disposition |
|---|---|---|---|---|---|
| Author year, `DOI` | | | | | |

> [WRITING NOTE] **The title column cannot be dropped** — what appears in the Part Two prose is "Author (year)", and this table has to match up with it.
> Dropped papers must keep their row; list only the ones that passed and this table becomes decoration.

## Appendix C: The boundaries of this review

- Sources covered: <list>. Not covered: <list>, so <some category> (engineering conferences, trial registries, patents,
  non-English literature and so on) may have been missed.
- "Not found" means only that it was not found under the sources and queries above.
- Citation counts are taken from <OpenAlex / Semantic Scholar>, and each vendor measures differently; **no download-count data** — not one of fastpaper's sources provides it.
  Every other judgment of "importance" in this report is a proxy and has been marked as such. There is no impact factor.
- The newest existing review stops at <year>; this review extends past it to <date>.
