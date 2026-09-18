---
name: fact-check
description: Check one specific claim against the literature — first break it into decidable sub-claims and confirm the breakdown with the user, then for each one find supporting evidence and counter-evidence, rate evidence strength by study design, and check whether the papers cited have been retracted; finally give a five-level verdict (holds / holds conditionally / insufficient evidence / counter-evidence exists / does not hold) and the boundary within which it holds, producing a short verification report. Use this skill when the user asks whether a statement is right, whether there is evidence for it, whether this is true, whether anyone has proven it, whether a sentence a reviewer wrote holds up, or whether they can write it that way. How it differs from a literature review — a review answers "what is this field", this one answers "does this sentence hold" — the only one of the four research skills with a right and a wrong.
---

# Fact Checking

The input is **one claim to be decided**, and the output is **one verdict**. This is the only skill with a right and a wrong — other deliverables can be a matter of opinion, this one cannot.

**Write in the language the user speaks.**

## Division of labor with the other skills

| | The question |
|---|---|
| `/research-ideation` | does my topic hold up |
| `/literature-review` | what is this field |
| `/research-frontier` | what has happened lately |
| `/paper-summary` | how does this paper go into my paper |
| **`/fact-check`** | **does this sentence hold** |

## Before starting

1. `date +%F`
2. `ls papers/` — the relevant papers may already be there.
3. **Pick sources, and read the SKILL.md of each search tool you will use** (they are in `<available_skills>`). Following AGENTS.md's "Looking for Papers", decide where the evidence sits — fastpaper, slowpaper, often both; it cannot be settled until Step 1 has split the claim into sub-claims.

## How to run the search commands

Everything in AGENTS.md's "how to use tools" applies. Run several queries as several parallel calls, but **batch downloads and rate-limitable calls 4–6 at a time** — a dozen parallel `get` calls at once makes Crossref return 429.

Only one thing belongs on disk: the final report (plus the PDFs `fastpaper download` puts into `papers/` itself).

When a download fails, **read the exit code first**: `4` = this source simply does not have it, so switching sources is the only move that means anything; `2` = the command was written wrong; `1` = something else.

---

## Step 1: Turn the claim into a decidable form

**Skip this step and everything after it is wasted.** "Wearables can give early warning of heart attacks" cannot be decided — which population? which device? how far in advance? what counts as a warning? Without nailing these down first, any evidence found can be read as supporting it and as opposing it.

How: break the original claim into **2–5 independently decidable sub-claims**, each satisfying "an experiment that could falsify it can be imagined".

Once broken down, **have the user confirm it with `ask_user_question`** (which must be called on its own). The same sentence usually admits several breakdowns, and **only the user knows which meaning they are asking about** — this is the one place in this skill where ask is irreplaceable. Give 2–4 breakdowns as the options, each option's `description` stating clearly what would be verified under that breakdown.

Where the user already pinned it down in the command, do not ask.

### Assign a type to each sub-claim

**The type decides the criterion, and without typing them the verdict cannot be accurate**:

| Type | Criterion |
|---|---|
| **Existence** "someone has done X" | one paper found and it holds |
| **Universality** "X always causes Y" | **one counterexample overturns it** |
| **Causal** "X causes Y" | correlation is not enough, interventional or quasi-experimental evidence is required |
| **Quantitative** "accuracy above 90%" | must be decided together with the conditions: which population, which data, which threshold |
| **Comparative** "X beats Y" | depends on which metric, under which conditions, and how large the difference is |

## Step 2: Find evidence, both for and against

**Looking only for supporting evidence is confirmation bias, and it is the most common failure in this kind of work.** Both routes must be walked.

### Positive evidence, stratified by study design

The `[pt]` filter on `pubmed` and `pmc` is verified to work (a nonexistent type reports `No results found`, and mutually exclusive type combinations return 0 results):

```bash
fastpaper search pubmed "<sub-claim terms> AND meta-analysis[pt]" -n 8
fastpaper search pubmed "<sub-claim terms> AND systematic review[pt]" -n 8
fastpaper search pubmed "<sub-claim terms> AND randomized controlled trial[pt]" -n 8
```

**Work from strong to weak, and once something strong is found there is no need to dig further down**: meta-analysis / systematic review → randomized controlled trial → prospective cohort → retrospective study → case report → expert opinion.

Outside biomedicine there is no `[pt]`; judge strength by other signals: multi-center or single-center, public benchmark or self-built dataset, whether there is independent replication, sample size, whether it is a preprint.

### Counter-evidence, searched for deliberately

Supporting evidence jumps out on its own, counter-evidence does not — it has to be sought deliberately:

```bash
# negation phrases × subject terms
fastpaper search pubmed "<subject> AND (\"no significant\" OR \"failed to\" OR \"did not improve\" OR \"no association\")" -n 8
fastpaper search europepmc "<subject> AND (\"negative result\" OR \"could not replicate\")" -n 8

# who refuted it afterward
fastpaper cite <DOI of the key supporting paper> --direction incoming -n 20
```

`cite --direction incoming` is the main route to finding that "this paper's conclusion at the time was later overturned". **When a claim is supported only by old evidence while the new evidence all opposes it, the verdict must reflect that.**

### Filters written into a query must be re-verified

`[pt]` is parsed by pubmed, and an unsupported one raises an explicit error. But **other conditions written into the query string are not necessarily parsed** — `europepmc`'s `CITED:>N` is silently ignored (only the range form `CITED:[N TO *]` takes effect). **For any filter written into a query, run it once more with an extreme value to verify it really took effect** (pushing the threshold very high should return zero results).

## Step 3: Check for retractions

**Every paper to be used as evidence must pass this gate.** Citing a retracted paper as evidence is the gravest error in fact checking.

```bash
fastpaper search pubmed "<title keywords of that paper> AND retracted publication[pt]" -n 3
```

A hit means it was retracted. Verified: the Wakefield 1998 paper does come up, and papers that were not retracted return `No results found`.

**This check works only on `pubmed` / `pmc`**, and retractions outside biomedicine cannot be found — in that case write truthfully in the report that this item was not done, do not pretend it was.

## Step 4: Check against the source text

Every concrete number, effect size, and direction of conclusion that enters the report must be verified back in the source text.

```bash
fastpaper read papers/<file>.pdf --list-sections
fastpaper read papers/<file>.pdf --grep "<key phrase>" --context 500 --max-matches 10
```

`--section --format json` returns the `heading`'s `text` / `page`, which is what marks the location.

**Evidence that cannot be verified in the source does not enter the report.** One unverified piece of evidence invalidates the whole verdict.

## Step 5: The verdict

**Five levels, each level's criterion nailed down, no vagueness permitted**:

| Verdict | When to use it |
|---|---|
| **Holds** | direct evidence supports it, and a deliberate search for counter-evidence found none |
| **Holds conditionally** | holds under a specific population / condition / convention, beyond which there is no evidence or there is counter-evidence. **This is the most common true state of an academic claim**; do not squeeze it into "holds" for the sake of a clean answer |
| **Insufficient evidence** | no evidence adequate to decide was found. **Which kind it is must be stated**: nobody has done it / it has been done but this endpoint was not reported / possibly I did not find it (state which sources and terms were searched) |
| **Counter-evidence exists** | evidence contrary to the claim exists, but not enough to overturn it outright (only one study, or different conditions) |
| **Does not hold** | strong evidence shows the claim is wrong, or a universality claim was overturned by a counterexample |

**The verdict must carry a boundary.** Not "holds / does not hold", but "**within what range it holds, and beyond what range there is no evidence**". Academic claims are almost never unconditional, and a verdict without a boundary is essentially always wrong.

**"No evidence found" does not equal "does not hold".** This is fact checking's most common mistake. Not finding it may mean nobody has done it, may be publication bias, may be that you did not find it — the three mean entirely different things to the user and must be written separately.

---

## Writing the report

The template is in `assets/report-template.md`; use `write` to write it into the **project root**:

```
fact-check-<claim-slug>-YYYY-MM-DD.md
```

Same style set as the other four skills. **Keep it to 500–750 words** — a verification report's value is in the verdict and the evidence chain, not in elaboration.
**Two kinds of blockquote in the template, do not confuse them.** The ones opening with `[WRITING NOTE]` are written for you, and **the whole block (down to the blank line) stays out of the report** — not one line of it may remain. Every other `>` blockquote — the verdict line at the top, and the one holding the claim as originally stated — **is part of the report**: keep it as it stands and fill in its placeholders.


**Plain Markdown only, no HTML tags** — KyDog's renderer has no rehype-raw.

**On a paper's first appearance write "Author (year), Full Title"**, and the title must not be truncated with an ellipsis.

When done, give three sentences in the conversation: which of the verdicts, the single most decisive ground, the report path.

## Honesty boundaries

- **Every piece of evidence goes through source-text verification and a retraction check**, and where that cannot be done, write truthfully that it was not done.
- **Not found ≠ does not hold.** State clearly in which sources and with which terms it was not found.
- **Not a single id may be invented.** Every DOI / PMID must have been confirmed back at the source.
- **Separate "what the literature says" from "my inference".** The verdict itself is an inference, the evidence it rests on is not — the two must be kept clearly apart.
- There are no impact factors and no journal tiers, so **evidence strength is judged only by study design and sample**, not by a journal's reputation.
