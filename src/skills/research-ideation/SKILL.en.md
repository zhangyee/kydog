---
name: research-ideation
description: Pin a research topic down with the nine Heilmeier questions, verify with literature search whether it holds up, and end with a "worth doing / needs narrowing / switch direction" verdict plus a set of adjacent topics. Use this skill when the user says they are starting a thesis topic, settling on a topic, assessing a research direction, writing a research proposal, checking whether anyone has already done an idea, or wondering whether their idea is novel — even when all they throw in is "I want to research X, what do you think". What it does beyond answering directly — forces out answers to nine questions, searches the literature into a six-box map, verifies every paper against its source before writing it into the report, and downloads the papers into papers/.
---

# Research Topic Assessment

Three steps: **pin it down → search it through → deliver a verdict**. The three are one chain, each step's output being the next one's input; skip the first and go straight to the literature, and all you will find is a pile of papers adjacent to what the user actually wants to do but out of focus.

The deliverable is one Markdown report in the project root, plus the PDFs in `papers/`.

## Before starting

1. `date +%F` — the report filename needs it, and you cannot guess today's date correctly on your own.
2. **Pick sources, and read the SKILL.md of each search tool you will use** (they are in `<available_skills>`). Following AGENTS.md's "Looking for Papers", decide where the literature sits — fastpaper, slowpaper, often both; the discipline and direction cannot be settled until Step 1's nine questions are answered. fastpaper's search syntax differs by source and its filter support differs by source; guessing flags from memory silently returns wrong results. Do not run `which fastpaper` to confirm it is there — KyDog bundles and ships it and injects the PATH, so it is definitely there; if it really is not, the error from the first search command is more accurate than probing.
3. If the user threw in only one line (nothing after `/research-ideation`, or just five or six words), use ordinary conversation first to find out what they want to do, in which discipline, and at what stage (topic not chosen yet / a preliminary idea in hand / already under way). **Do not use ask_user_question for this step** — it is an open question, and turning it into a multiple-choice one only boxes them in.

## How to run the search commands

Everything in AGENTS.md's "how to use tools" applies here in full: one fastpaper command per bash call, read stdout directly, do not create directories, do not write intermediate files (`fastpaper search -o` included), do not write scripts to merge results.

For this skill specifically: **only two things belong on disk** — the PDFs in `papers/` (`fastpaper download -d papers/` creates the directory itself), and the final report.

Search results in particular do not belong on disk, and the reason is not tidiness: **their persistence layer already exists — it is those databases.** DOI / PMID / arXiv id are stable pointers, and `fastpaper get <id>` retrieves the authoritative version at any time. A local JSON copy starts going stale the moment it is written, and verification goes back to the source item by item anyway — since you have to `get` each one regardless, that cache was never actually depended on. Judgments must rest on facts fetched back from the source, not on an old copy on disk.

### Choosing the output format

| Situation | Format | Volume at `-n 8` |
|---|---|---|
| Triage: scan titles to decide what deserves a close look | **default table** (no `--format`) | ~1.8k characters, with id, title, year, authors |
| Exact field comparison (metadata verification) | `--format json` | ~20k characters, **11×** |

fastpaper's SKILL.md tells you to use json every time; that line is for situations needing exact field parsing, telling `null` (unknown) apart from missing. **You do not need that precision at the triage stage** — table already gives you id and title, and once a paper looks worth it, `fastpaper get <id>` fetches the full fields. Running json across the whole search round is the easiest way for this skill to burn the context to nothing.

---

## Step 1: The nine Heilmeier questions

When George Heilmeier ran DARPA in the 1970s, he required everyone applying for funding to answer a set of questions. That set is still the standard checklist for assessing research projects in science and technology. The full nine, what each one tests, and what good and bad answers look like are in `references/heilmeier.md` — **read it before drafting any options**.

### Scout first, then draft

Before drafting options, run one round of **scouting search**, purely to learn what this field looks like right now, what the mainstream approach is called, and what the past three years have been arguing about.

**Scale: 2 sources × 2–3 queries, `-n 8`, default table format, run one at a time.** That is 4–6 calls in total, and what you read is titles and years. Scouting is not a census — it only has to keep your options grounded; searching more adds no value and only burns context at a stage where the questions have not even started.

Tell the user what you are doing ("I will scan the field first, then start asking you the nine questions"), do not leave the interface silent for tens of seconds.

Scouting results **do not enter the map**; their only use is keeping the options you draft grounded. This step pays for itself — answering "how is this done now" from your own memory is where hallucination starts in an obscure direction, while answering from real papers you just found gives the options weight immediately.

### How to ask

`ask_user_question` is a multiple-choice tool, and the nine Heilmeier questions are open questions. The bridge is that **you draft the answers for the user first, and they pick one or rewrite it**:

- Give **2–4 candidate answers** per question, different phrasings and different positions on **this specific topic of theirs**, not a generic template like "yes / no / not sure". Template options carry almost zero information about a specific topic, and the user looking at them will not know which to pick either.
- Mark the one closest to your own judgment as `recommended` (at most one per question).
- The user can **write their own** beyond the options (the tool has a free-text field). Tell them this before the first round, or they will assume they must pick one of three.

Tool constraints (violating one gets the whole batch rejected):

- **Must be called on its own**, it cannot sit in the same batch of tool calls as another tool.
- 1–4 questions at a time, 2–4 options each.
- `header` must not exceed 12 characters.

The nine questions run in three rounds, 3 per round:

| Round | Questions | Suggested header |
|---|---|---|
| 1 | Q1 jargon-free goal · Q2 status quo and limits · Q3 novelty and odds | Goal / Prior art / Novelty |
| 2 | Q4 who cares · Q5 what changes on success · Q6 risks | Audience / Impact / Risk |
| 3 | Q7 resources · Q8 time · Q9 measure of success | Resources / Timeline / Metrics |

Between rounds you may adjust the next round's options based on the previous answers — the phrasing the user picked in Q1 changes what counts as a reasonable candidate for Q4 "who cares". Do not settle all three rounds' options up front and then recite them.

### Handling the answers

- **The user skips a question** (the text that comes back is "(the user skipped this question)"): that question is unanswered, and the report says so truthfully. **The skip is itself information** — Q9 skipped in particular means this topic has no success criterion yet, and that must go into the Step 3 assessment. Do not fill one in for them.
- **The user closed the prompt** (the text that comes back is "The user closed the prompt without answering."): stop this round and ask whether they want to talk it through another way or set it aside for now. Do not answer the nine questions for them on your own.
- **Q1 is the hardest and the most famous one**. If the answer the user finally settles on still carries field jargon, say so plainly ("X and Y in this sentence are not something an outsider follows"), and offer a plainer rewrite for them to confirm. Heilmeier's own words: if you cannot explain it, you have not thought it through. This is the most valuable output of this step; do not let it slide for the sake of seeming smooth.

Once the nine answers are collected, go straight to Step 2; there is no need to have the user confirm again — they just picked through them one question at a time.

**The nine questions do not go into the report, not in the body and not in an appendix.** The report's first chapter is prose synthesizing the nine answers, and that is the deliverable; the raw Q&A is **raw material**, a reader holding the synthesis does not need it, and the person who answered them needs even less to see what they just filled in. If tracing back is really needed, the session log holds the full text.

There is one more concrete reason: the `ask_user_question` result gives you back only each option's `label` (a short tag of 1–5 words), not its `description`. Copied back verbatim they are a column of terse fragments ("Prediction and detection both", "Out-of-hospital monitoring gap"), unreadable to anyone out of context. **When writing the first chapter, use the full meaning of the option you drafted yourself plus the user's custom addition, not that short tag.**

---

## Step 2: Literature map and verification

The detailed search strategy, the criteria for the six boxes, and the verification protocol are in `references/literature-map.md` — **read it before starting to search**. Only the skeleton is here.

### 2.1 Search

Pull three axes out of the nine answers: **object/phenomenon terms**, **method/technique terms**, **outcome/measure terms**. Cross the three axes into queries, every axis carrying synonyms and broader terms. The target is 12–20 queries covering more than 4 data sources, not dropping the topic title into a search box once as is.

**How to run them: one at a time, triage on the default table format, and fetch full fields with `fastpaper get <id>` for the ones that look worth it.** Do not write loops or write to disk in order to "search it all in one go" — 12–20 table outputs (about 1.8k characters each) is an amount you can read through, and the same number of json ones is not.

Choose sources by discipline and by where the literature sits (AGENTS.md's "Looking for Papers"; fastpaper's `sources --capabilities` is live; run it once when unsure). Deduplicate across sources by DOI.

**Keep count while searching**: how many queries each source ran, how many hits, how many remain after deduplication, how many were screened through into verification. The report's very first line is that funnel, and **the nine numbers are all different**:

> sources N1 → queries N2 → hits N3 → after dedup N4 → **screened into verification N5** → into the conclusions N6;
> full text = **newly downloaded this round D1** (the difference between the two `ls papers/` runs in §2.4) + **already in `papers/` D3** = N8

The N4 → N5 step is triage; leave it out and the reader will think you threw literature away.

**D1 and D3 must be written separately.** Report only "N8 full texts obtained" and the reader will certainly read it as "all N8 came down this round" — when most of the full text was already in `papers/`, that misreading is the exact opposite of the fact. This is the spot in that whole line most likely to mislead.

This funnel decides how the reader weighs every conclusion that follows. **It cannot be reconstructed afterward; record it as you go.**

### 2.2 The six-box map

Sort the search results into six boxes. Keep empty boxes too and write "not found" — an empty box carries information:

1. **Established findings** — multiple independent studies agreeing
2. **Contested findings** — those whose conclusions contradict each other, which must be **listed in pairs**; listing one paper alone is not a controversy
3. **Null results** — work that was done and did not pan out. The hardest to search and the easiest to miss; `references/literature-map.md` has dedicated search tactics
4. **Mechanism** — literature explaining "why this happens"
5. **Methodological landscape** — what methods people use to measure this, and the known limits of each
6. **Closest prior papers** — the 3–5 nearest this topic, each with one **precise gap statement**

Box 6 is where the report is most valuable. A gap statement must be **falsifiable in one sentence**:

- Good: "they only validated in mice, with no human data" — checkable, right or wrong is clear-cut
- Good: "their sample size is 32, which cannot detect effect sizes below 0.4"
- Empty words: "they did not go deep enough", "there is room for further research" — sentences like these hold for any paper, which is to say nothing at all

**"Six boxes" is your working vocabulary, not the report's table of contents.** In the report this chapter is called "Literature map", and its six subsections take the six names above directly: Established findings / Contested findings / Negative findings / Mechanism / Methodological landscape / Closest related work. **But "box N" must not appear even once in the body** — the reader does not know how many boxes you made, and does not need to. Likewise: "three-axis term extraction" and "verification ledger" belong only to your working process and do not enter the deliverable.

### 2.3 Verification (two levels, item by item)

Every paper and every claim in the map must point back to a real source. This step is the reason this skill exists — a fabricated literature map is worse than no map, because it looks credible.

**Existence + metadata**: `fastpaper get <id>` for every paper, comparing whether title, year, first author, and journal match what you wrote into the map.

- Not found → delete it from the map
- Found but not matching what you wrote → correct it to the source result, or delete it
- **The two sources contradict each other** (OpenAlex says 2023, Europe PMC says 2024, for instance) → present both side by side with a note, do not pick one on your own authority. This is AGENTS.md's verification discipline verbatim, and the only honest handling

**Literature with no identifier** (most Chinese journal articles and theses, found on Baidu Xueshu or Scholar) cannot be traced back with `fastpaper get`, so "not found → delete it" does not apply to it — that is a gap in the source's coverage, not a paper that does not exist: existence rests on the record in the source that found it, the map marks it "confirmed only by 〈source〉" and puts it on the unverified checklist, and no DOI is made up; where you saw only the record or an abstract snippet, say what it studied, not what it concluded.

**Claims**: every conclusion written into the map as fact (a number, an effect size, the direction of a conclusion) must point to a specific location in a specific paper.

- `fastpaper download <id> -d papers/` for the PDF, then `fastpaper read papers/<id>.pdf --section results --max-length 4000` to go back to the exact section and compare
- **Read only the section you need**, do not pull the whole paper in. Section-scoped reading is what makes this step finishable in sequence
- Where the full text is out of reach, fall back to the abstract; a claim backed by the abstract alone is marked `[abstract only]` in the report
- The source does not match what you wrote → change it to what the source says, or delete that claim

**Keep two sets of counts while verifying**, needed by the report's "Literature verification outcome" section and impossible to count afterward:

- At the paper level: how many were verified, how many entered the conclusions, how many were removed (and why each), how many metadata corrections were made
- At the claim level: **how many conclusions were checked**, how many of those against the full text, how many backed by the abstract alone, how many corrected or deleted for not matching the source

**The per-paper verification record goes into Appendix A of the report**, one line per paper: paper / source lookup / metadata match / claim basis (full text / abstract only / not obtained) / disposition. Removed ones keep their line too — list only the ones that passed and the table becomes decoration.

**What goes in the body is the outcome, not a running table**: the last section of the "Literature map" chapter is called "Literature verification outcome", and it uses the two sets of numbers above to answer "how far were these conclusions verified". It decides what the reader uses this map for, so it comes before the assessment.

### 2.4 Downloads

**`ls papers/` once when starting, and `ls papers/` again before writing the report.** These two are not a repeat:

- The first decides what to download. This directory may already hold papers the user put there themselves, or ones downloaded in earlier sessions — what this round needs may well be in there, and `fastpaper read` is then enough, with no `download` call at all.
- The second is for **counting accurately**: the difference between the two is this round's new D1, and the ones in the first that are relevant to this round's topic are D3. **Do not count from memory how many download commands you issued** — with source switches, and failures that later succeeded, memory will get it wrong. Two `ls` calls are protocol-level fact; memory is not.

Match by filename, and the rule is: **a DOI's `/` becomes `_`** (`10.2196/31129` → `papers/10.2196_31129.pdf`), while arXiv ids and PMC ids stay as they are (`1706.03762.pdf`, `PMC10944676.pdf`). The directory will also hold files the user named by hand (`Azadian_NatBiotech_2026.pdf` and the like); recognize those by title.

For the rest use `fastpaper download <id> -d papers/`. It blocks duplicate downloads itself (`File already exists: ...`, exit code 0), so the earlier `ls` is about fewer calls and picking up what is already there, not about preventing overwrites.

Many downloads will fail (paywalls, anti-scraping, a landing page returned, no open access, source-side rate limiting, and papers published that year that aggregators have not indexed yet). **Read the exit code first**: `4` = the request was fine and this source simply does not have it, so switching sources is the only move that means anything; `2` = the command was written wrong; `1` = something else. For anything other than `4`, go by the judgment given in fastpaper's error, do not start a retry strategy of your own. On failure, record "not obtained" in the appendix verification table. **Do not fabricate a successful download** — the user will go looking for the file in `papers/`.

**Changing your story midway means going back and changing the numbers.** The typical way to get this wrong: you first tell the user "none of these 9 came down", then switch sources, try twice more and succeed once, yet the report still carries the old numbers, keeping even self-contradictory sentences like "9 = 1 + 8". Any count spoken out loud mid-session must be re-checked against the last `ls papers/` when writing the report.

---

## Step 3: Assessment and other directions

### Assessment

**An assessment is two actions, recounting and appraising, and neither can be missing**: first recount clearly what the literature says on a question, then appraise what it means for this topic. Recounting without appraising is a survey; appraising without recounting is hot air. This is the chapter's only formal requirement, and the one most easily dropped.

**Write it as prose, do not write it as a scorecard.** A judgment's weight comes from the argument, not from labels in a table — with a table full of "partially supported", the reader cannot see what you judged on, and so cannot disagree with you.

**State the position once at the start and once at the end**, with argument all the way between. This is the rule of the form, not a layout preference: the reader needs to know where you stand before they can read your argument with that stance in mind.

The body unfolds across four sub-themes, each section being two paragraphs, recount → appraise:

| Sub-theme | What to recount | What to appraise |
|---|---|---|
| Whether the novelty still stands | how far the closest related work got | whether the novelty they claim is a real gap or already filled; whether what remains can carry a project |
| Whether it can be pulled off | what each existing method costs, and who came unstuck where | whether the resources and timeline they hold buy the step they want |
| Whether the risk is where they think | which failure modes the contested and negative findings point to | whether these are the same set they named in Q6; whether any recur in the literature that they never mentioned |
| Whether the claimed value holds | how far the established findings support it | how far the evidence supports the benefit and change they describe, and where extrapolation begins |

**Write out the criteria for the judgment.** An appraisal cannot be "I think so" — state what you judged on (whether the gap statement is falsifiable, whether the method required is reachable within their resources, whether the success criterion is observable). With the criteria written out the reader can disagree with you; without them, this assessment is only an opinion.

**Do not attach a separate "where each of the nine questions landed" table.** The four prose sections have already been over every claim of theirs once; another table lists what was just said all over again. Questions they answered do not need reciting and scoring item by item in the report.

There is one case that must be named in the prose: **a question was skipped**. Q9 above all — with a topic that cannot state a success criterion, three years on nobody (themselves included) can judge whether it was achieved, and that goes into the "whether it can be pulled off" section.

**Pick one of three verdicts**:

- **Worth doing** — the gap is real, the method is reachable, the resources match
- **Needs narrowing first** — the direction is right but too big or too diffuse; say where to narrow it to and why the part cut away cannot hold up
- **Switch direction** — the gap does not exist, or is already filled, or the resources are nowhere near enough

Citations **point to specific studies (author + year), they do not point to the report's own section numbers**. Fence-sitting ("it has some value and some challenges") is of no use to the user — they came to you for a verdict. Say a negative verdict plainly too; that is far kinder than letting them spend three years hitting a wall.

When the verdict is "needs narrowing", after restating the verdict at the end, give: the narrowed topic statement, why it narrows that way, and 3–6 **things to settle before starting**. Each must correspond to a specific failure mode in the literature (who came unstuck where), not to generic research advice.

### Other directions worth pursuing

3–5 of them, under the same subject. **Write them the way a review is written**: first recount the specific tension or gap in the literature, with author-and-year citations, then draw the topic out of it.

The good version:

> González-Cabeza et al. (2025) report that three-lead reaches micro-F1 77% on static five-class classification, close to 12-lead's 78%, while Zepeda-Echavarria et al. (2024) find sensitivity for OMI on a real four-electrode device is only 65%. No study has yet attributed this gap — does it come from lead selection, or from real acquisition conditions? On that basis one could …

The bad version:

> Hangs on: the box-2 controversy over "whether three leads are enough".

The reader cannot follow internal numbering and should not have to. You know in your own head which gap in the map each direction hangs on — one that hangs on nothing was made up out of imagination, so delete it — but **what gets written down must be the literature itself**.

Do not write sentences like "one could study the application of X in the field of Y" either, which fit any field at all.

### The report

The template is in `assets/report-template.md`; use `write` to write it into the **project root**:

```
research-ideation-<topic-slug>-YYYY-MM-DD.md
```

The topic slug is English or pinyin joined by hyphens, no spaces. The date is the result of `date +%F` from when you started.
**Two kinds of blockquote in the template, do not confuse them.** The ones opening with `[WRITING NOTE]` are written for you, and **the whole block (down to the blank line) stays out of the report** — not one line of it may remain. Every other `>` blockquote — currently only the count line at the top — **is part of the report**: keep it as it stands and fill in its placeholders.


**Plain Markdown only, do not write HTML tags.** KyDog's renderer is ReactMarkdown + remark-gfm with no rehype-raw — `<details>`, `<summary>`, `<br>` display verbatim as strings. If content needs collapsing, put it in an appendix; collapsing is not an available option.

Two things that are easy to botch:

- **The first line is the funnel numbers** (the nine numbers in §2.1), not "search tool: fastpaper". Which tool you used is internal implementation and the reader does not care; how thick the evidence is decides how they read every sentence after. When done, check N3 ≥ N4 ≥ N5 ≥ N6, N8 = D1 + D3, N8 ≤ N5 — anything that does not add up means you miscounted.
- **The first chapter is prose, not a Q&A**. Use three to five paragraphs to make the topic clear. The reader may read only the first chapter and the assessment chapter, and each of those two must stand on its own.

When done, give a summary in the conversation: which of the three verdicts, the two or three most decisive grounds, the report path, how many papers landed in `papers/`. Do not recount the whole report — it is already in the file.

---

## Honesty boundaries

These are not pleasantries; they are the precondition for anyone being able to use this report:

- **Not found ≠ does not exist**. Say "in these sources, with these keywords, nothing was found", and list the sources and the keywords. Let the reader judge whether it is a real gap or you simply did not find it.
- **What fastpaper cannot get, say it cannot get**. It has no impact factors, and citation relations are available only from the semantic and openalex sources; any other "relatedness" (shared authors, same journal, conceptual proximity) is a proxy, and using one means labeling it a proxy.
- **Not a single id may be invented**. Every DOI / arXiv id / PMID appearing anywhere in the report must have been confirmed at the source with `fastpaper get`. Where that cannot be done, do not write that item.
