# Search Strategy, the Six-Box Map, the Verification Protocol

Used alongside Step 2 of SKILL.md. Prerequisite: fastpaper's SKILL.md has already been read, so you know which filters each source supports.

---

## 1. Search strategy

### Crossing three axes

Pull three axes out of the nine answers and cross them into queries:

| Axis | Which question it comes from | Example ("predicting depression relapse with wearables") |
|---|---|---|
| Object / phenomenon | Q1 jargon-free goal, Q4 audience | depression relapse, mood episode recurrence, MDD |
| Method / technique | Q2 status quo, Q3 novelty | wearable, actigraphy, passive sensing, digital phenotyping |
| Outcome / measure | Q9 measure of success | prediction, early warning, PHQ-9, longitudinal |

Every axis carries **synonyms** and **broader terms**. The broader terms are the critical part: the same thing goes by different names in different disciplines, and searching only the term the user used misses half the field.

Target: **12–20 queries, covering more than 4 data sources**. Dropping the topic title into a search box once as is is this step's most common way to fail — it only hits the most superficial layer.

**One command per call, default table format** (see "how to run the commands" in SKILL.md). Table already gives you id, title, year, authors, enough for triage; `--format json` is reserved for comparing fields at the verification stage, and it is 11 times the size of table. Do not write loops, do not write to disk with `-o`, do not merge with scripts — needing a merge means you asked for too much at once.

### Four angles on a search

Search the same subject from each of these four angles at least once; they hit different sets of papers:

1. **Head-on subject terms** — search object × method directly
2. **Up and downstream** — search the broader problem above it, and the more specific sub-problems
3. **Adjacent methods** — whether the same problem has been done by other methods
4. **Citation chains** — once you have found 1–2 foundational papers, `fastpaper cite <id> --direction incoming` shows who cited them. This is the only way to find the batch of papers whose "keywords are entirely different but substance is related", and the main entrance to finding controversies

### Choosing sources

Go by discipline, do not send every query at the same source:

| Discipline | Primary | Supplementary |
|---|---|---|
| Biomedical / clinical | `pubmed` `europepmc` `pmc` | `medrxiv` `biorxiv` (preprints) |
| CS / AI | `arxiv` `dblp` `semantic` | `openalex` |
| Interdisciplinary / unsure | `openalex` `crossref` `semantic` | `core` `doaj` |
| Chinese-language literature | `xueshu` | serial and slow, do not hit it concurrently |

Across sources, **deduplicate by DOI**. Those without a DOI (preprints, conference papers) are compared on normalized titles, with the source noted in the map.

`fastpaper sources --capabilities` is live; when unsure whether some source supports some filter, run it once, do not guess.

---

## 2. The six-box map

Every paper entering a box carries: title / first author / year / journal or conference / an id that traces back to the source (one of DOI, arXiv id, PMID). **Anything without a traceable id does not enter a box** — it cannot be verified, and so cannot be used.

Empty boxes are kept and marked "not found", with the keywords and the sources you searched attached. An empty box carries information, and erasing it erases evidence.

### 1. Established findings

Those where multiple **independent** studies agree. The criteria:

- At least 2–3 studies from different teams (several consecutive papers from the same group do not count as independent)
- Or one systematic review / meta-analysis

How to write it: one conclusion per line, with the papers supporting it hung underneath. Do not write one line per paper — that is a reference list, not a map.

### 2. Contested findings

**Must be listed in pairs (or in groups)**. Listing one paper alone is not a controversy, it is just one paper.

Each controversy states clearly:

- What is being contested (two different answers to the same question)
- Who is on each side, and what each concluded
- Where it can be made out: the likely source of the disagreement (different sample populations / different measurement methods / different statistical conventions)

A controversy is one of the best landing spots for a topic — a study that settles an existing controversy has its novelty and its significance ready-made.

### 3. Null results

Studies that were done and did not pan out. **The hardest to search, the easiest to miss, and the most valuable** — because of publication bias, negative results sit largely below the waterline, and not knowing where others failed, you are quite likely to walk the same path again.

Dedicated search tactics:

- **Negation phrases × subject terms**: `"no significant"` `"failed to replicate"` `"null result"` `"negative result"` `"no association"` `"did not improve"`. These work directly on sources that pass the query through as is, such as `pubmed` / `europepmc` / `crossref`
- **Registered reports / preregistration**: `"registered report"` `"preregistered"` — such studies commit to publishing whatever the result, and their share of negative results is far higher than in ordinary literature
- **Preprints**: `biorxiv` `medrxiv` have not been through journals' publication-bias sieve
- **Dig through limitations**: for those closest prior papers in box 6, `fastpaper read --section discussion` — authors often write in there "we tried X but were unable to …". This is the most reliable route to negative results
- **Reverse citations**: `cite --direction incoming` to find those that cited a foundational paper yet reached the opposite conclusion

If genuinely nothing was found: write "searched [these terms] in [these sources], found no study explicitly reporting a negative result", and remind the reader that this is **very likely publication bias rather than genuine absence**. That reminder must be written — it is the only value this box can offer when it has no content.

### 4. Mechanism

Literature explaining "why this happens". The difference from box 1: box 1 is "what was observed", this box is "why".

Where the mechanism is clear, the risk lies mainly in engineering implementation; where the mechanism is unclear, the risk lies in the hypothesis itself possibly not holding. This distinction goes straight into the Step 3 risk assessment.

If this box is empty (the phenomenon has been observed but nobody can say why), **that is itself a high-value landing spot for a topic**, and it gets named among the Step 3 adjacent directions.

### 5. Methodological landscape

What methods people use to measure this. For each method record:

- Method name / representative paper
- What it actually measures (often not quite the same as what it claims to measure)
- Known limits (cost, sample-size requirements, the conditions under which it fails)

In Step 3 this box is **the basis for judging feasibility** — set it against the resource answers from Q7/Q8 and you can see whether there is a route the user can afford to what they want to do.

### 6. Closest prior papers

3–5 of them, the nearest to this topic. Each must carry one **precise gap statement**.

The criterion for a gap statement: **falsifiable in one sentence**.

| Good | Why it is good |
|---|---|
| "they only validated in mice, with no human data" | one check tells you whether it is right |
| "sample size 32, cannot detect effect sizes <0.4" | it has a number, it can be computed |
| "only the acute phase was measured, no follow-up beyond 6 months" | the boundary is clear |

| Bad | Why it is bad |
|---|---|
| "they did not go deep enough" | true of any paper |
| "there is room for further research" | same as above |
| "real application scenarios were not considered" | unless you can name which scenario, this too fits anything |

**This box is where the whole report is most valuable**. Step 3's judgment on "whether the novelty genuinely exists" rests entirely on the gap statements here. If not one precise gap can be found, that is itself the conclusion — this topic may already have been done.

---

## 3. Verification protocol

A fabricated literature map is worse than no map: it looks credible, and it will be taken into a research proposal and used to persuade a supervisor. So item-by-item verification is not optional.

### 3.1 Existence + metadata

For every paper in the map:

```bash
fastpaper get <DOI|arXiv_ID|PMID>
```

Compare four items: **title, year, first author, journal/conference**.

| Result | Disposition |
|---|---|
| Not found | delete from the map; the ledger records "could not be traced to source, removed" |
| Found, all four match | keep; the ledger records "match" |
| Found, one item does not match | correct the map, **the source result being authoritative**; the ledger records "corrected: <which item>" |
| Found, but the content is an entirely different paper from what you assumed | delete; the ledger records "id does not match content, removed" |

That last kind is hallucination's most typical form: the id is real (it belongs to another paper) and the title is made up. So **the title must be compared**; confirming that the id resolves is not enough.

### 3.2 Claims

Every conclusion written into the map as fact — a number, an effect size, the direction of a conclusion, "so-and-so found such-and-such" — must point to a specific location in a specific paper.

```bash
fastpaper download <id> -d papers/
fastpaper read papers/<id>.pdf --section results --max-length 4000
```

**Read only the section you need.** `--section` takes abstract / introduction / methods / results / discussion / conclusion / references / full. Section-scoped reading is what makes the whole verification finishable in sequence — pull twenty full texts into the context and there is no headroom left for judgment.

Choose the section by the type of claim:

| Claim type | Which section to read |
|---|---|
| Concrete numbers, effect sizes | `results` |
| Direction of the conclusion, the authors' own qualitative framing | `abstract` or `conclusion` |
| Sample size, population, how it was measured | `methods` |
| Limitations the authors admit, attempts that failed | `discussion` |

When unsure which sections a PDF has, list them first with `fastpaper read <pdf> --list-sections`; that is cheaper than guessing one and failing.

To find a specific statement in the full text ("what limitations the authors admitted", "in what context some number appears"), use `--grep`: `fastpaper read <pdf> --grep "limitation" --context 500 --max-matches 10` (regex, case-insensitive by default). **Do not dump the full text and sift through it yourself, and even less write it to a file and search it with a script.**

| Situation | Disposition |
|---|---|
| The source supports it | keep; the ledger records "verified against full text" |
| Full text out of reach, abstract supports it | keep; mark that item `[abstract only]` in the map; the ledger records "abstract only" |
| Neither full text nor abstract obtainable | keep the citation at the metadata level only, **write no concrete numbers or conclusions**; the ledger records "not obtained" |
| The source disagrees with what you wrote | change it to what the source says; the ledger records "corrected: <what changed>" |

### 3.3 The verification ledger

Goes into the report, one line per paper:

| id | Source lookup | Metadata | Claim basis | Disposition |
|---|---|---|---|---|
| 10.1038/xxx | ✓ | match | full text (results) | kept |
| arXiv:2401.xxxxx | ✓ | year corrected 2023→2024 | abstract only | kept, effect size deleted |
| 10.1016/yyy | ✗ not found | — | — | removed |

**Removed ones must keep their line.** The ledger's entire value is in letting someone see that you really did check item by item, and what the checks turned up. List only the ones that passed and it degenerates into decoration.

If a whole round of verification turned up not one problem, write a line of explanation below the ledger — that means either the search quality was very high or the verification was not done seriously, and the reader has a right to know which you lean toward.

### 3.4 Downloads

Try to download every paper that entered the map into `papers/`. Failure is common (paywalls, the source not supporting download, the wrong id type, papers published that year not yet indexed by aggregators). **Read the exit code first**: `4` = this source simply does not have it, so switching sources is the only move that means anything; `2` = the command was written wrong; `1` = something else. On failure, record "not obtained" in the ledger.

**Do not fabricate a successful download.** The user will go looking for the file in `papers/`, and the moment it is not there, the whole report's credibility is gone.
