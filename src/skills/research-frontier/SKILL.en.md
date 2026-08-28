---
name: research-frontier
description: For one specific research direction, find what new work appeared in the past year, which groups keep working it and along what trajectory, which established assumptions have been shaken, what new terminology the field has grown, and what is still contested; produce a 900–1500 word frontier briefing. The default reader is an insider in this direction — no background, no review, only "what you may have missed this year". Use this skill when the user asks for the latest progress in a direction, research hotspots, frontier developments, what new things there have been lately, how far this direction has got by now, whether anyone has overturned anything, or which group is leading this direction. How it differs from a literature review — a review looks backward, builds a consensus map, and pastes into a paper; this one looks forward, gives judgments to decide on, and every paper in it has been verified back at its source.
---

# Frontier Briefing

The deliverable is **a 900–1500 word Markdown briefing**, and the reader is an insider in this direction.

**Do not give background, do not build a consensus map, do not restate what this direction is.** That is `/literature-review`'s job. This one answers a single question: **what may I have missed this year.**

**Write in the language the user speaks.**

## Division of labor with the other two skills

| | The question | Time orientation | Reader |
|---|---|---|---|
| `/research-ideation` | does my topic hold up | testing one hypothesis | whoever is choosing a topic |
| `/literature-review` | what is this direction | looking back, consensus settled | whoever is writing a paper |
| **`/research-frontier`** | **what happened lately, what should I watch** | **looking forward, consensus not yet formed** | **whoever is already inside** |

## Before starting

1. `date +%F` — both the time window and the filename need it.
2. **read fastpaper's SKILL.md** (it is in `<available_skills>`). Syntax and filter support differ by source, and guessing flags silently returns wrong results.
3. `ls papers/` — the papers may already be sitting there.
4. **Confirm the direction is specific enough**. A grain like "applications of artificial intelligence in medicine" produces no frontier — everything happens in a year, and saying so says nothing. Where it is too broad, use ordinary conversation to ask the user to narrow it to a direction one sentence can describe.

## How to run the search commands

Everything in AGENTS.md's "how to use tools" applies: one fastpaper command per bash call, read stdout directly, do not create directories, do not write intermediate files (`-o` included), do not merge with scripts. Run several queries as several parallel calls.

**But do not fire off too many downloads or rate-limitable calls at once** — measured, 15 parallel `get` calls make Crossref return 429, and 10 parallel `download` calls all fail before the lesson is learned. Batch such operations 4–6 at a time.

Only two things belong on disk: the PDFs in `papers/`, and the final briefing.

**Output format**: scan titles with the default table (`-n 8` is about 1.8k characters); reach for `--format json` only when fields must be compared exactly (~20k for the same count, 11 times over).

---

## Step 1: Search

**The time window defaults to the past 12 months** (`--after <this year minus 1>-<current month>-01`). An insider already holds a two-year map, and what the briefing owes them is what they may have missed this year. Where the direction moves slowly and 12 months turns up nothing, widen it to 18 or 24 months, **and write in the briefing how far it was widened** — a direction with nothing new in a year is itself a conclusion.

Five entry points run in parallel, **none of them depending on another**:

```bash
# 1. subject terms, past 12 months
fastpaper search pubmed "<subject terms>" --after <this year minus 1>-<month>-01 -n 10

# 2. preprints — 6–18 months ahead of journals, the frontier's first scene
fastpaper search arxiv   "<subject>" --after <this year minus 1>-<month>-01 -n 8
fastpaper search biorxiv "<subject>" -n 8
fastpaper search medrxiv "<subject>" -n 8

# 3. cross-disciplinary sources — this discipline's searches never see them
fastpaper search arxiv "<subject>" --field <adjacent discipline category> --after <this year minus 1>-<month>-01 -n 8

# 4. published recently yet already accruing citations = heating up (sort only on semantic)
fastpaper search semantic "<subject>" --after <this year minus 1>-01-01 --sort citations -n 10

# 5. who is following up on the recent key work
fastpaper cite <DOI of some recent paper> --direction incoming -n 20
```

The third, cross-disciplinary entry point is the critical one: people bringing methods in from another field cite **their own side's** canon, which neither this discipline's vocabulary nor its citation network finds. From a biomedical direction go to `arxiv --field eess.SP / cs.LG`; from a CS direction go to `pubmed` `europepmc`.

### Three traps that must be avoided (all measured)

**Do not compute a "citation growth rate".** `cite` has neither `--sort` nor a date filter, it can only truncate; measured on one paper (280 citations in total), the share of citations from the past year came out as 28% / 43% / 56% under `-n 25 / 60 / 120` — **the distribution drifts with `-n`**, so what is computed is the parameter you typed, not heat. To speak of heating up, use entry point 4 above, and call it honestly "work published in the past N years that ranks high on citations".

**In this skill `--sort citations` has exactly one legitimate place: `semantic`. Not one other source may use it, no exceptions.** The reasons split into two kinds, and neither is something "just try it and see" resolves:

- **Sources that fail outright**: they publish no citation counts, the command errors, and a call is spent for nothing.
- **Sources that do not error but return the wrong thing**: sorting by citations crushes the relevance weighting, and back come the whole discipline's behemoths (search wearable ECG, get UK Biobank and ESC guidelines). This kind costs more — it looks like it worked.

Where citation ordering is wanted and `semantic` does not suit (its recall on this subject is too poor, say), **do not sort at all**: switch to `--sort date` or drop the ordering, and state in the appendix that this round did no citation ordering. Do not go try it on another source.

**`CITED:>N` does not take effect; the range form `CITED:[N TO *]` is required.** fastpaper's SKILL.md gives `CITED:>500`, but measured, the `>` form is silently ignored (thresholds of 500 and 100000 return exactly the same results); only the Lucene range form actually filters:

```
CRISPR AND CITED:[0 TO *]      → 20 results
CRISPR AND CITED:[10000 TO *]  →  5 results
CRISPR AND CITED:[50000 TO *]  →  1 result
```

Generalizing: **for any filter written into a query string, run it once more with an extreme value to verify it really took effect** (pushing the threshold very high should return zero results). Such conditions are parsed at the source end, invisible to fastpaper's validation layer, and getting one wrong raises no error. Two calls buy away a whole class of silent errors.

**What does not exist**: download counts (none of the 18 sources provide them), year-by-year publication-volume trends (`search` does not return a total hit count), clinical trial registries (ClinicalTrials.gov is not among the sources). Do not pass off another metric in their place, and do not write vague phrases like "has attracted wide attention".

---

## Step 2: Five signals

The briefing's skeleton is exactly these five sections. **Citation counts lag by 1–2 years by nature, so measuring the frontier with them is a beat late to begin with** — which is why the last four do not depend on citations.

### 1. Recent significant advances

Group by **where the newness lies**, not by chronological sequence. Three kinds kept apart: **new method / new data or new setting / new result**. Preprints must be marked.

The criterion: an insider reading it says "I had not noticed that", not "I know that". Failing that, the search went too shallow — change the terms and go again.

### 2. Revisions to established conclusions

**This section is worth the most to an insider** — they already hold a map in their head, and what they most want to know is **where it needs changing**.

The form is paired: **X was what everyone thought (hung on the old paper) → new work shows Y (hung on the new paper) → degree of destabilization**. Degree comes in three grades: **overturned / scope of applicability narrowed / a first counterexample has appeared**. The three mean entirely different things; do not blur them into "has been challenged".

Keep this section even when it is empty, writing "none found" — no assumption shaken in a year means this direction is converging rather than opening up, and that is a conclusion.

### 3. Principal research groups and their research trajectories

Both kinds are needed, **the long-standing ones first**.

#### 3a. Groups working the direction continuously

For a group producing continuously over years with a coherent body of results, their **trajectory of evolution** says more about where the direction is headed than any single new paper. This is what an insider most wants to know and can least easily see for themselves — they have read each individual paper, but stringing five years of one group's work into a line takes deliberate pulling.

How: pick the authors recurring across the search results, and pull each one's continuous output.

```bash
fastpaper search pubmed "<subject>" --author "<Surname Initials>" --sort date -n 10
```

`--author` is available on `pubmed` `pmc` `europepmc` `crossref` `openalex` `arxiv` `core` `openaire` `doaj` `zenodo` `hal`; `semantic` `dblp` `scholar` `xueshu` `biorxiv` `medrxiv` do not support it, but they raise an explicit error (`Error: semantic does not support --author`) rather than failing silently — those sources put the person's name into the query string.

**What gets written is a trajectory, not a paper list.** Pick 2–4 waypoints that let a reader see what they went from and to:

> The Al-Zaiti group (Pittsburgh): 2023 on interpretability and atrial fibrillation prediction → 2024 co-authoring a scientific statement on AI in cardiology (reaching the guideline layer) → 2025 turning to the clinical usability of saliency maps, risk stratification for suspected ACS, and OMI-specific networks → 2026 on adversarial debiasing and temporal imputation. **From "can it be done" to "can it be trusted, is it fair, what about missing data"** — that line says the direction's main battleground is shifting from model performance to clinical trustworthiness.

For each group write: **who / how many years they have kept at this direction / 2–4 waypoints on the trajectory / where the past year points / what makes them a leader**. That last one needs grounds — repeatedly pointed at by citation chains, having defined a task or a benchmark, having been written into a guideline or consensus statement, all count; "publishes a lot" does not.

#### 3b. Groups newly entering the direction

Above all those **migrating in from another discipline**. A signal-processing group suddenly working on clinical endpoints is worth watching.

For each write: who, which field they came from, what method they brought, why this migration may work out.

### 4. Newly emerged terminology

The words this direction has grown lately. **Each new term is followed by a line on "what it finds that the old words do not"** — this is the only part of the briefing that directly improves the reader's own searching, and it is far more useful than listing a few more papers.

Where the terms come from: while reading the new papers, watch for words that **do not appear in the literature of a year ago**.

### 5. Open controversies

Live points of disagreement. **Write them in pairs**: who concluded what, who is on the other side, where the disagreement may come from.

The defining feature of a frontier is that **there is no consensus yet**. If everyone in a direction agrees, it is no longer a frontier but a consensus — and that is itself worth naming in the briefing.

---

## Step 3: Verification

**A short deliverable does not mean verification can be loose.** A fabricated frontier briefing directly affects someone's decision about where to put their effort.

**Existence + metadata**: `fastpaper get <id>` for every paper, comparing title, year, first author. Not found means delete it; where two sources contradict each other, present both side by side, do not pick one on your own authority.

**Claims**: every concrete number, effect size, and direction of conclusion in the briefing must point to the source text. `fastpaper read papers/<file>.pdf --section results --max-length 4000` goes back to the exact section.

**When unsure which sections a PDF has, list them first**, which is cheaper than guessing one and failing:

```bash
fastpaper read papers/<file>.pdf --list-sections
```

PDFs from Nature-family journals (Scientific Reports, Nature Communications) **carry no `Abstract` or `Introduction` labels**; their form is **abstract → Results → Discussion → Methods**, not IMRaD. On these, `--section abstract` fails cleanly with an error — running `--list-sections` first avoids it.

**To find a specific statement in the full text, use `--grep`, do not dump the whole text and sift through it yourself**:

```bash
fastpaper read papers/<file>.pdf --grep "limitation" --context 500 --max-matches 10
```

Regex, case-insensitive by default (use `(?-i)` for case-sensitive). For checking questions like "what limitations the authors admitted" or "in what context some number appears", it is far faster and far cheaper than reading a whole section.

Where the full text is out of reach, fall back to the abstract, **and mark in the appendix which claims are backed by the abstract alone**.

**"Abstract only" is written as two distinct things, never merged.** In the appendix paper list, verification level is one of three:

| Label | Meaning |
|---|---|
| `full text` | The full text was read — downloaded this round, or already in `papers/` |
| `full text not fetched` | The source has it; this round judged the abstract sufficient and did not fetch it |
| `no full text at source` | It was tried, and the source simply does not have it |

The last two are both backed by abstract alone, but the reader reacts to them completely differently: "not fetched" means they can go get it themselves, "none at source" means they will not get it either. Collapsing both into "abstract only" states the former as if it were the latter — **the reader concludes you tried and could not, when in fact you did not try**. Marking something `full text not fetched` is nothing to be ashamed of, as long as the appendix says why the abstract was judged sufficient; getting the label wrong is the problem.

## Step 4: Downloads

`ls papers/` once when starting, `ls` again before writing the briefing, and the difference between the two is this round's additions. Do not count from memory how many download commands were issued.

Filename rule: a DOI's `/` becomes `_`, while arXiv ids and PMC ids stay as they are.

**This skill's full-text acquisition rate is inherently low, it is structural, and calls spent rescuing it are wasted.** Measured, one round of 9 downloads had 6 failures, and the failures were **all papers published that year** — PMC / Europe PMC / CORE take weeks to months to ingest full text, while a frontier briefing by definition searches the past 12 months, so the closer to today the less obtainable.

**Switching sources essentially does not rescue it**: those 6 were each tried on `europepmc` and `core` with zero successes; searching their titles on `arxiv` for preprints hit nothing for five of them (preprints in clinical behavioral medicine live on medRxiv, and medRxiv itself blocks PDF downloads). `unpaywall` does not work either — for these papers it holds only landing pages, no direct PDF links. So:

- **Read the exit code first.** `4` = the request was fine and this source simply does not have it (no such paper / no OA copy / `--grep` matched nothing), so switching source or switching id is the only move that means anything; `2` = the command was written wrong, fix the command; `1` = something else. **Do not retry indiscriminately on seeing a failure** — the exit code has already told you whether you should.
- **For anything other than `4`, go by the judgment fastpaper gives.** Its download errors tell you which URL was tried and whether switching sources is worth it (for instance "Other resolvers usually hand back this same URL, so opening it yourself is more likely to help than retrying through another source"). **Copy its judgment, do not start a retry strategy of your own.**
- When reporting a failure cause, **write the cause, do not just copy the error string**: "published new in 2026, aggregators have not ingested the full text yet" is far more useful to a reader than "Response is not a PDF"
- **Open access ≠ obtainable**. A new paper in a fully OA journal like Frontiers is free on the publisher's site but absent from the aggregators

So it is normal for this briefing to have **a great many claims backed by the abstract alone**; label them truthfully in the appendix, with no need to feel sheepish about how little full text there is — but that is no license to treat what the abstract says as verified against the full text.

**Everything above is about journal papers.** It was learned on the ingestion lag at PMC / Europe PMC / CORE, and it does not hold for preprint sources — `arxiv`, `biorxiv`, `zenodo` and `hal` are all ✓ for download, and a new paper has a PDF the same day. So: an undownloaded preprint is labeled `full text not fetched` in the appendix, not `no full text at source`, and its reason is written as "the abstract was judged sufficient" — it may not borrow the "structurally out of reach" line.

**Do not fabricate a successful download.**

---

## Step 5: Writing the briefing

The template is in `assets/briefing-template.md`; use `write` to write it into the **project root**:

```
research-frontier-<direction-slug>-YYYY-MM-DD.md
```

Same style set as `research-ideation-*` and `literature-review-*`.

**Conclusions first.** Open with 3–5 one-sentence conclusions, each hung on a paper. The reader may read only this passage — it has to stand on its own.

**The default reader is an insider**: do not explain what this direction is, do not define terminology (apart from the new ones in section 4), do not lay groundwork for why it matters. Every bit of space saved goes to judgment.

**Every judgment must point to a specific paper**, and clearly separate "what the literature says" from "my inference". The frontier is by nature where evidence is thin, so inference is unavoidable — but it must be marked.

**Give the title on a paper's first appearance**: "Author (year), Title", shortened to "Author (year)" only on later mentions, with preprints marked on first appearance. The briefing body has no reference list next to it, and with author and year alone the reader cannot tell which paper it is. The paper list in the appendix (title + DOI) **cannot be dropped** — a briefing that says "you missed these" is as good as unwritten if the reader cannot get hold of those papers.

**Keep it to 900–1500 words.** A frontier's value is in timeliness and judgment, not in completeness; write it long and nobody reads it, and it inevitably slides toward being a review.

**Two kinds of blockquote in the template, do not confuse them.** The ones opening with `[WRITING NOTE]` are written for you, and **the whole block (down to the blank line) stays out of the briefing** — not one line of it may remain. Every other `>` blockquote — currently only the coverage line at the top — **is part of the briefing**: keep it as it stands and fill in its placeholders.

**Section names and labels use academic register, not colloquial.** `[WRITING NOTE]` blocks may talk however they like; but **every heading, table header, and field name that will appear in the briefing is written in academic register**. "Principal research groups and their research trajectories", not "teams worth watching"; "Open controversies", not "what people are still arguing about"; "Revisions to established conclusions", not "beliefs that need updating". This thing gets forwarded to supervisors and colleagues.

When done, give a three-sentence summary in the conversation: the single most important finding, the one person or group most worth watching, the briefing path.

---

## Honesty boundaries

- **Not found ≠ did not happen.** State clearly in which sources, with which terms, and within which time window it was not found.
- **A preprint must be marked as a preprint.** The reader has a right to know it has not been peer reviewed, and the preprint share in a frontier briefing runs high.
- **Not a single id may be invented.** Every DOI / arXiv id must have been confirmed back at the source with `fastpaper get`.
- **Plain Markdown only, no HTML tags.** KyDog's renderer has no rehype-raw, so things like `<details>` display verbatim.
