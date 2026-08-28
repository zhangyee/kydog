---
name: learning-deck
description: Three interview rounds find which layer the user already stands on for a topic, a method, or a concept in a paper, then fill in only the missing layers, producing an illustrated offline HTML self-study report — knowledge map, one section per concept (one-line definition → problem it solves → mechanism diagram → misconceptions and limits → sources), method comparison table, glossary, close-reading list. Use it when the user wants to understand a concept in a paper, what a method actually does, or a field's basics, wants to be brought up to speed, to get started, to learn from scratch, says explain X to me, asks how X works, or why something is designed that way. Beyond plain explanation it searches reviews, tutorials and foundational papers, not the latest progress, verifies and downloads every paper, and redraws mechanism diagrams as inline SVG from the original. Given a paper it teaches **the concepts inside it**; writing it into your own paper is `/paper-summary`'s job.
---

# Self-study knowledge report

The deliverable is **one HTML report in the project root**, plus the PDFs in `papers/`,
plus one `.learning-deck-<slug>-YYYY-MM-DD.json` sharing the report's name —
the report's content is written into that JSON first and rendered into HTML only once it is settled; **the JSON is kept after delivery** (see Step 5).

HTML is there for **the figures, the layout and the pacing**: mechanism figures as inline SVG, captions right up against the figure, method comparison as a real table,
chapter curtain pages, arrow keys jumping between sections, items entering one at a time.

The reader is **this one person in front of you**, not a generic beginner. What this report covers and what it skips is decided by the Step 3 interview —
the same topic should produce different reports for different people. Fail at that and this skill degenerates into an encyclopedia entry.

**Write in the language the user speaks.**

## This skill comes in five volumes

SKILL.md covers only the process and the discipline. Read the five volumes below as needed; paths are relative to `<skill dir>` —
take that from this skill's `<location>` in `<available_skills>` (it is the absolute path of this SKILL.md,
with the trailing `SKILL.md` removed):

| When to read it | Which volume |
|---|---|
| **Before designing any interview question** | `references/interview.md` — the shape of a question, the caps, how the three rounds build up, how the answers land in the report |
| **Before fetching any figure** | `references/figures.md` — `fastpaper figures`, exit-code branches, the capability branch, embedding and attribution discipline |
| **Before writing any JSON** (all of Step 5) | `references/deck-json.md` — the JSON's shape, the five block types, the JSON→HTML rendering map, the JSON self-check |
| **Before filling body text into the JSON** (the most important volume) | `references/writing.md` — what each slot should look like, seven requirements each with a positive and a negative example |
| **Before rendering / during the post-render self-check / when the user wants the structure changed after delivery** | `references/layout.md` — the list of classes and components, the SVG rules, the HTML-layer grep commands, and "Changing the structure afterwards: delete a chapter / insert a chapter / reorder" |

`assets/report-template.html` is the skeleton, and **read it through completely before rendering**:
the header comments carry the hard constraints that fail silently, and each `<section>`'s comment marks ①–⑩ and what goes in it.
**The template's `<body>` contains no example content** (since v5, reason at sub-step 5.5) — every position waiting to be
filled is a comment carrying `⟨待填⟩` or `⟨待填: …⟩`; the complete samples you can copy from are in `references/layout.md`.

## Division of labor with the other five skills

| | Question | Assumed reader |
|---|---|---|
| `/research-ideation` | Does this topic of mine hold up | Someone who already has an idea |
| `/literature-review` | What is this field | Someone about to write a paper |
| `/research-frontier` | What has happened lately | Someone already inside the circle |
| `/fact-check` | Does this claim hold | Someone about to make a judgement |
| `/paper-summary` | How does this paper go into my paper | Someone in the middle of writing |
| **`/learning-deck`** | **What is this thing really, and how should I learn it** | **Outside the circle, starting point measured by interview** |

**When a paper is given, either skill may be right**: wanting to understand the concepts in it that make no sense is this one;
wanting to write the paper into your own related work is `/paper-summary`. If you are unsure, ask in ordinary conversation, do not guess.

## Before starting

1. `date +%F` — the report's file name needs it, and you cannot guess today's date.
2. **read fastpaper's SKILL.md** (it is in `<available_skills>`). Search syntax and filter support differ from source to source, and guessing a flag from memory silently gets you wrong results.
3. `ls papers/` — the paper they want to ask about, or the review that ought to be read, may already be in there.
4. **Confirm the direction is not boundless.** A grain like "applications of artificial intelligence in medicine" cannot produce a self-study report — the knowledge map spreads into a web touching everything a little, and every concept gets three sentences. If it is too broad, ask in ordinary conversation for it to be narrowed to a topic, method or concept that one sentence can describe. **Do not use `ask_user_question` for this step** — it is an open question, and turning it into multiple choice only constrains them.

## How to run the search commands

Everything in AGENTS.md's "how to use tools" applies: one fastpaper command per bash call, read stdout directly, do not create directories, do not write intermediate files (`search -o` included), do not merge results with scripts. Use several parallel calls for queries that do not depend on each other.

**Triage on the default table, do not turn on `--format json`.** A `-n 8` table is about 1.8k characters and already gives id, title, year and authors, which is enough to decide which papers deserve a closer look; the same number of records as json is ~20k, **11×**. Only turn on json when you need to compare fields exactly (verifying metadata). Leaving json on for a whole round of searching is the easiest way for this skill to burn through the context — and it still has a long HTML with inline SVG to write afterwards.

**Only three things should go to disk**: the PDFs and figures in `papers/`, the `.learning-deck-<slug>-YYYY-MM-DD.json`, and the final HTML report. **The last two are deliverables, not intermediate files** (the JSON is kept after delivery, reason at Step 5). Everything else — the knowledge graph, the raw search results, the candidate reading list — stays in the context; do not write a file first just to "tidy things up". The interview results need no separate file: they land in that JSON as each chapter's `tier` field.

---

## Step 1: fix the target (no interruption)

**When a paper is given** (a DOI, an arXiv id, or the path to a PDF under `papers/` all count): get hold of it first.

```bash
fastpaper get <id>                       # confirm which one it is
fastpaper download <id> -d papers/
fastpaper read papers/<file>.pdf --list-sections
fastpaper read papers/<file>.pdf --section introduction --max-length 4000
```

**If it is already in `papers/`, start from those two `--list-sections` lines**; the first two commands are not needed.

Reading it is for **extracting which concepts it depends on** — the terms in the introduction and methods used directly as though known are the candidates for the second layer of the knowledge map. It is not for summarizing the paper.

**When a topic or a method is given**: go straight to Step 2.

## Step 2: first round of searching — find "which concepts to cover"

**The goal of this round is a list of concepts, not evidence.** So prioritize **reviews, tutorials, primers and foundational papers** over the latest progress.

**This is the exact opposite of `/research-frontier`**: that skill searches the last 12 months and wants what has not yet settled; this skill wants precisely what has settled — textbook-level explanations, original papers cited over and over, the one review that once explained a field properly. **Do not add `--after`**, because foundational papers are often ten to thirty years old.

```bash
fastpaper search semantic "<topic> review"            -n 10
fastpaper search semantic "<topic> tutorial"          -n 8
fastpaper search semantic "<topic> introduction primer" -n 8
fastpaper search semantic "<topic>" --sort citations  -n 10   # highly cited ≈ settled
fastpaper search arxiv   "<topic>" --field <adjacent category>  -n 8
fastpaper cite <DOI of some review> --direction outgoing  -n 20   # what a review cites is this field's canon
```

That last one takes the least effort: **a good review's reference list is a ready-made list of concepts**, and `cite --direction outgoing` pulls it out in one go.

`--sort citations` is **only used on `semantic`**. Sorting by citations on `crossref` and `openalex` goes badly off topic (relevance weighting gets overridden and you get the whole discipline's giants back); `pubmed` errors out explicitly.

**This round only scans titles, it downloads nothing.** The output is a **2–3 layer candidate knowledge graph**:

- Top layer: the target concept (the one they asked about)
- Second layer: what it depends on directly
- Third layer: what the second layer depends on in turn

That graph is the question pool for the Step 3 interview, and also the draft for the SVG of ② the knowledge map at the end. There is no need to go below the third layer — if it is really needed, that is the next deck's business.

## Step 3: three rounds of interview

**This step is where this skill's entire value sits. Skip it and the output is generic popular science.**

**Read `references/interview.md` before designing any questions.** It has the shape of a question (one concept per question,
three options for three tiers of mastery, single choice), how to open, how the three rounds build up, and how the answers land in the report.

Only three things belong here at the process level:

1. **`ask_user_question` must be called on its own** and cannot sit in the same batch of tool calls as another tool —
   the whole batch gets blocked. One tool call in the batch, wait for the answer, then send the next batch.
2. **One concept per question, and ask plenty**: at most 10 questions per round, at most 30 concepts across three rounds; using them all is normal.
   The first question of round 1 asks **how far they want to get** (follow along / run it themselves / modify it),
   asking only about learning depth, never about project planning — that is `/research-ideation`'s business.
3. **What the next round asks is decided by the previous round's answers.** Fixing all three rounds up front is the same as not interviewing.

## Step 4: second round of searching — get the evidence and get the figures

The interview settled which sections get written, and only now does this round **download PDFs into `papers/`** (except the paper from Step 1 — the one they named is read at the start, without waiting for the interview).

**Downloading is required, not optional.** Redrawing an SVG presupposes having understood the original figure; a figure drawn from the abstract alone is invented, and an invented mechanism figure is worse than no figure at all, because the reader will take it as true.

- **In batches of 4–6.** In practice 10 parallel `download` calls at once all fail before any lesson is learned (rate limiting at the source).
- **Look at the exit code first**: `4` = the request was fine, this source simply does not have it (no such paper / no OA copy), so only another source or another id will help; `2` = the command is written wrong, fix the command; `1` = something else. **Do not retry every failure indiscriminately** — the exit code already tells you whether you should.
- Outside of `4`, follow the judgement given in fastpaper's error rather than inventing your own retry strategy.
- Where the full text cannot be had, **fall back to the abstract**, and state in ⑩ the honest boundaries which claims rest on abstracts only.

**This skill's full-text hit rate is naturally decent**: foundational papers and reviews tend to be older with good OA coverage, far more favorable than `/research-frontier`'s scenario of searching the last 12 months. So when the full text will not come, first consider whether another source has it.

Reading the full text works as it does in the other skills: **probe the structure first, then read a chosen section**:

```bash
fastpaper read papers/<file>.pdf --list-sections
fastpaper read papers/<file>.pdf --section methods --max-length 4000
```

PDFs from the Nature family (Scientific Reports, Nature Communications) have no `abstract` / `introduction` labels; their convention is abstract → Results → Discussion → Methods. When the list does not have them, read from the beginning: `--max-length 3000`.

**To redraw a particular figure, use `--grep` to pull out the passages about it**, rather than dumping the full text and sifting through it yourself:

```bash
fastpaper read papers/<file>.pdf --grep "Fig(ure)? ?1" --context 600 --max-matches 6
```

Regex, case-insensitive by default. The caption plus the two paragraphs where the body first discusses it are usually enough to draw a structurally correct diagram. **Before drawing, ask yourself: can I point to a source in the original for every box and every arrow in this figure?** If you cannot, do not draw that part.

**Fetch the original figures in the same batch**:

```bash
fastpaper figures <id> -d papers/
```

**Read `references/figures.md` before you start** — the exit-code branches (neither `4` nor `1` is retried),
file names not matching figure numbers, `.pdf` going through `pdf_figure_to_png`, `.eps` being skipped,
**whether original figures can be embedded at all depending on whether the current model can see images**, plus the embedding and attribution discipline, are all in that volume.

**Every paper that goes into the report has to be verified back at source with `fastpaper get <id>`**: compare title, year and first author. If it cannot be found, delete it from the report; if two sources disagree, present both side by side rather than picking one on your own.

## Step 5: write the report (six sub-steps)

**Content goes into the JSON first, and is rendered into HTML only once it is settled.** Six sub-steps; do not merge them and do not skip any.

Why the detour: the report's body has to be written by you regardless, and **thinking while writing across two thousand lines of HTML**
means redoing the whole body on every revision — so "assemble it once and write it back" is forever less work than matching `oldText` section by section.
Across three real runs the agent went around `edit` and rewrote the whole thing three times (once perl, twice python), and this is the root of it.
The JSON separates "think the content through" from "turn it into HTML": **5.1–5.4 never touch the HTML**, and changing a chapter is changing a few lines;
by 5.5 the content is fixed and you just paste according to the map, **with only the figures drawn on the spot at that step**.

**Read `references/deck-json.md` before you start** — the JSON's shape, the five block types
and the rendering map are all in that volume. The single most important rule it lays down: fields like `html` / `intro` / `aside` are
**string arrays, and every element is one line of the rendered HTML, indentation included**, pasted verbatim at render time.

That rule is not fastidiousness, it is the entire reason "revise after rendering" can be cheap:
changing a passage is **one `edit` on a line of the JSON, then the same `oldText` / `newText` used for one more
`edit` on the HTML** — the second is a copy-paste of the first. 1 change becomes 2, not 1 becoming 20.
Only structural changes — adding a block, deleting a block, reordering — require re-rendering a chapter, and even that is a hundred-odd lines.

⚠️ **SVG does not go into the JSON.** The JSON says only "what to draw" for each figure (the `figure` block's `sketch` field,
and ② the knowledge map's `map.sketch`), and **the markup itself is not written out until 5.5**.
The reason: what 5.1–5.4 settle is content, and nobody reviews the pedagogical value of SVG markup; while the SVG is the single most expensive
part of the whole report, and putting it in the JSON means writing it twice (once escaped into the JSON, once pasted into the HTML),
violating the point of the separation at exactly the most expensive place. Record the cost too: **the JSON alone cannot re-render the original figure.**

### 5.1 Write the JSON skeleton

- **Input**: the knowledge graph from Step 2, the interview tiers from Step 3, the literature and figures from Step 4.
- **Output**: `<project root>/.learning-deck-<slug>-YYYY-MM-DD.json`, skeleton only.
- **How**: create it with one `write`. **This is the only time `write` is used on the JSON in the whole process; after this, only `edit`.**
  In the skeleton the top-level fields (`title` / `date` / `forWhom` / `glossary` / `references` …) may start empty,
  but each chapter's `number` / `id` / `title` / `lede` / `tier` are written for real now, with `blocks` left as `[]`.
- **Hand-off**: this skeleton is exactly what 5.2 checks.

The slug is English or pinyin joined by hyphens, no spaces; the date is the result of that `date +%F` from "Before starting".
The HTML report uses the same slug and the same date, under the same naming scheme as `research-ideation-*` / `literature-review-*` /
`research-frontier-*`.

#### Settle `hero` while you are at it (which look the header cover band uses)

The top-level `hero` field is one of three: `gridwave` / `constellation` / `holoband` (what the three look like is in
the `hero` section of `references/deck-json.md`).

**Look it up from the slug; picking one yourself is not allowed.** What "pick one yourself" actually produces is the first one every time,
which amounts to not having the field. The lookup is two table lookups and one crossing, purely mechanical, with no counting and no arithmetic:

**Step one**, take the **first two letters/digits** of the slug (skipping hyphens) and look up a bucket number for each:

| Bucket | Letters | Digits |
|---|---|---|
| **0** | a d g j m p s v y | 0 3 6 9 |
| **1** | b e h k n q t w z | 1 4 7 |
| **2** | c f i l o r u x | 2 5 8 |

**Step two**, use "the first character's bucket" for the row and "the second character's bucket" for the column:

| | 2nd = 0 | 2nd = 1 | 2nd = 2 |
|---|---|---|---|
| **1st = 0** | `gridwave` | `constellation` | `holoband` |
| **1st = 1** | `constellation` | `holoband` | `gridwave` |
| **1st = 2** | `holoband` | `gridwave` | `constellation` |

Example: `ecg-fm-ami-2026-08-21` → first two characters `e`, `c` → bucket 1, bucket 2
→ row 1, column 2 → **`gridwave`**.

⚠️ **Take the first two characters, not the last.** A slug always ends in the digits of the date, so looking up from the end means
one face per date — every report made on the same day would look identical. The first two characters fall inside the topic slug and have nothing to do with the date.
(This table was tried on a set of 35 realistically shaped slugs: the three looks came out 13 / 12 / 10, with no landslide.
Switching to "first letter + last letter" gives 18 / 11 / 6 — English and pinyin word endings pile up on s / g / n.)

⚠️ **No randomizing at run time.** This value is written into the JSON and the HTML, and **reopening the same report has to give the same
face**. If the user wants a different one, changing `hero` and `data-hero` in the HTML is enough (see 5.5).

### 5.2 Self-check the TOC, then print the outline

- **Input**: the skeleton from 5.1.
- **Output**: a settled chapter sequence, plus an outline printed into the conversation.
- **Hand-off**: **go straight to 5.3 once the self-check is done. This step asks nothing, waits for nothing, and sets no gate.**

⚠️ **There is no confirmation pause here (the user's decision).** Earlier versions stopped here to ask the user three things.
Measured on the fifth real run: **283 seconds** had already been spent before reaching this point — the person had long since switched the window away,
and **asking a question in a window that has been switched away is not asking**, it only makes the process wait a round for nothing.
The pause was originally argued for as "the TOC is cheapest to settle here", and that cheapness is now supplied by **chapter-by-chapter rendering** in 5.5:
go back to the JSON, change one chapter, re-render only that chapter. **Removing the pause is not giving up calibration, it is moving calibration after delivery** —
which is why the delivery message at 5.6 must spell out how to make changes, and the route for structural changes is in
`references/layout.md`, "Changing the structure afterwards: delete a chapter / insert a chapter / reorder".

**Self-check three things first. These three are your job, not the user's — even more so now that the pause is gone: nobody else will look at them for you.**

1. **Coverage** — is every concept marked "never encountered" or "heard of it, cannot explain" in the interview accounted for?
   Either it becomes a chapter or it goes into ④ the primer; not one may be dropped on the floor.
2. **Order** — go chapter by chapter and ask "by the time they read this chapter, has what it depends on been covered?" If not, move it or add a chapter.
3. **Granularity** — is any chapter worth three of the others? Is any chapter so thin it should be merged into ④?

**If any of the three fails, go back to 5.1 and fix it yourself; do not take it to the user.**
Order, coverage and granularity are expert judgements, and with the Step 2 knowledge graph and the Step 4 literature in hand they were always yours to make.
The user is running this skill precisely because they do not know this material — having just asked them "you do not know these things",
turning around to ask them to review the pedagogical structure of that material is handing your own judgement to the person least equipped to make it.

**Once the self-check passes, print the outline. This is leaving them a record, not a review, and not waiting for a nod.**
It costs nothing, and looking back through the conversation later they can see what was settled without opening the JSON.

The key is that **every chapter has to be tied back to what they said themselves in the interview**: a string of terms they have never seen
tells them nothing at a glance about whether this is what they wanted; put in their own words, one glance is enough. So three lines per chapter:

```
§3 Normalization: per lead or per whole record
   You said · on the "z-score" question you picked: knows it is subtract the mean and divide by the standard deviation, but had never thought about what a different statistical scope changes
   This section covers · what each of the three statistical scopes computes, and why cross-centre data has to go per lead
```

The rules for the middle line matter more than the chapter title itself:

- **Use the exact option description they read and selected**, do not swap in your own wording.
  Still less write "tier: heard of it, cannot explain" — the tier names are our internal labels, and they have never seen those three words.
- **Anything they wrote themselves outside the options is quoted verbatim**, and that is the most valuable line of all:
  `You said · what you wrote was "I have only run it on MIT-BIH, and it collapses on another dataset"`.
- **Chapters they were never asked about** (prerequisites you added yourself after round 3) are labelled honestly, rather than fabricating something they never said:
  `You said · this one was not asked — it is a prerequisite for §5, and I judged it had to come first`.
- **Questions they skipped** are handled as "heard of it, cannot explain" per `references/interview.md`, and that line says so honestly:
  `You said · you skipped this one, so I am treating it as "heard of it, cannot explain"`.

**Close with one sentence, declarative, and carry straight on:**

> That is the outline of this report, N chapters in all. I will write it on this basis.

- **Do not report the reading time here.** `readingMinutes` cannot be computed until every chapter is written at the end of 5.3
  (algorithm in `references/deck-json.md`), and anything reported at this step would be made up on the spot.
  The duration will appear on the meta line in the report's header, and by then it is computed.

- **No question may be attached after this passage.** "Is there a chapter you do not need?" "Is the length right?" "Anything else you want cleared up?"
  — not one of them. Attaching one gets no answer from anyone; it only makes you believe you should stop and wait.
  **Once that closing sentence is written, the next action is the first `edit` of 5.3.**
- **Do not use `ask_user_question`, and do not stop and wait by any other means either.**
- **If the user interjects an opinion of their own along the way**, act on it: go back to the 5.1 file, change it, then carry on.
  That was volunteered by them, not solicited by you — do not conflate the two.

### 5.3 Fill the content into the JSON chapter by chapter

- **Input**: the skeleton settled at 5.2.
- **Output**: a JSON filled with content — every chapter's `aside` / `blocks` / `boundary` / `source` /
  `checkout`, plus the top-level slots still left empty.
- **How**: **one `edit` call per chapter.** Take as `oldText` those five lines of that chapter from `"id": "c3",` through to
  `"blocks": []` (`id` / `title` / `lede` / `tier` / `blocks` run consecutively and are
  naturally unique in the whole file), and as `newText` those same lines with `blocks` replaced by the filled content
  and `boundary` / `source` / `checkout` appended. One call may carry several `edits[]`,
  but **do not merge across chapters** — one chapter at a time, so a mistake only costs that chapter.
- Once every chapter is filled, fill in the top-level `map` / `primer` / `compare` / `summary` /
  `glossary` / `next` / `references` / `honesty` / `forWhom` — they cannot be written accurately until the chapters are settled
  (the knowledge map's nodes have to point at real chapter numbers, the glossary has to cover the words the body actually uses,
  and `references[].id` has to cover every paper cited in each chapter's `source[]`).
  **Leave `readingMinutes` to the very end**, algorithm in `references/deck-json.md`.
- **Read `references/writing.md` before writing** (the most important volume: v1 had every slot filled and was entirely format-compliant,
  yet read like a reviewer's checklist, and those seven items are the difference), and look up block types and fields in `references/deck-json.md`.
- **Figures at this step carry intent only, no SVG.** A `figure` block's `sketch` settles three things:
  `form` (is the skeleton a timeline / a process chain / two facing columns / a layered block diagram…), `elements[]`
  (what is on the figure, the line of text on each, how they relate to one another, 4–8 items),
  and `emphasis` (the single most important spot and why it matters). ② the knowledge map's `map.sketch` is the same,
  plus `nodes[]` / `edges[]`. The granularity of the fields and the two edges (too coarse / too fine) are in
  "`sketch`: what this figure draws" in `references/deck-json.md`.
  **Not one angle bracket goes into a `sketch`** — coordinates, colors, classes and viewBox all belong to 5.5,
  and writing them here is retyping the SVG in prose.
- **Hand-off**: finish filling everything before moving to 5.4; do not check as you fill.

### 5.4 Check the JSON's content

- **Input**: the filled JSON.
- **Output**: a JSON that passes the self-check. **At this step the HTML still does not exist, and not one SVG has been drawn.**
- **How**: read the whole JSON through (it is small enough to read), run the 6 groups of "JSON self-check" in `references/deck-json.md`,
  then read it as a person against item 9 of `references/writing.md`.
- **What the figures are checked for at this step is "is it worth drawing, is it drawing the right thing"**, not the markup: does each chapter have a figure (J-B 6),
  are the figure numbers continuous (J-B 10), is the source stated (J-B 7), does the `sketch` have all three fields (J-B 8),
  has any drawing slipped into a `sketch` (J-B 9). Then read `emphasis` as a person —
  **if it cannot say which step of the mechanism this figure is about, the figure has not been thought through; send it back to 5.3 rather than improvising at 5.5.**
- **Hand-off**: if it fails, go back to 5.3 and fix that chapter — **you are changing a few lines of JSON, not a few hundred lines of HTML**.
  Only once everything passes does it go to 5.5.

### 5.5 `cp` the template, render chapter by chapter

- **Input**: the JSON that passed the self-check + `assets/report-template.html`.
- **Output**: `<project root>/learning-deck-<slug>-YYYY-MM-DD.html`.
- **How**:

```bash
cp <skill dir>/assets/report-template.html <project root>/learning-deck-<slug>-YYYY-MM-DD.html
```

**`cp` a copy first, then edit the copy. Do not `write` a fresh one from scratch.** Having the model regenerate a file this large
word by word typically ends with the style block omitted or rewritten (turned into `/* styles as in the template */`, rules merged,
media queries dropped), and **losing one CSS rule raises no error, the layout is just wrong when opened**.
**The `<style>` and the `<script>` at the end of the file are both left exactly as they are; do not change or retype one character**;
and the `div.hero-band` inside `<body>` (the dark cover band at the top, before `<div class="deck">`)
is likewise **kept whole and verbatim** — it is a purely decorative layer, and **the only thing to change is that one `data-hero` value**,
filled from the JSON's `hero` (see 5.1). **Do not delete it**: the three lines of header text use the light palette that comes with the band,
and without the band the title is a light color on light paper — invisible, and with no error.

**One thing at this step is not pasting: drawing the figures.** Each figure in the JSON has only a `sketch` (what to draw),
and the SVG markup is written out here — `form` fixes the skeleton, `elements[]` fixes what is drawn and the line of text on each,
and the `emphasis` spot takes `.svg-hi`. **How to draw follows the "Drawing SVG" section of `references/layout.md`**
(viewBox 640 wide, font size inside a figure never below 12, colors only from the template's classes, each figure carrying its own `<defs>`),
and do not invent your own scheme. Not one word of the `sketch` itself enters the HTML.

⚠️ **If you cannot draw it, the `sketch` was not written fully enough; go back to 5.3, write it out, then come back and draw** —
do not improvise the design here, because that means this figure's content was never reviewed by 5.4.

⚠️ **The template's `<body>` contains no example content (v5, the user's decision).** Every position waiting to be filled
is a comment carrying `⟨待填⟩` or `⟨待填: …⟩`; **every one of them must be consumed by an `edit`**, with no exceptions
and no cheap path of "copy one and change a few words".

Why it was changed this way: v4's template came with the shells of two example chapters, and this step's instruction was "chapters 1 and 2 use up those two
shells, chapter 3 onward uses insertion". **The two paths cost far too differently** — insertion's `oldText` is one comment line,
while replacing a shell has eighty lines of example SVG in its `oldText`. The result of the fourth real run was that all nine chapters took the cheap
insertion path and the two shells stayed where they were: 9 chapters in the JSON, 11 curtain pages in the HTML, contents not matching the body,
and 41 pieces of example text left across the report. **The same mistake for the third time, and the root is the same every time: a cheap path was left that skips
work that had to be done.** There is no shell to use now, insertion is the only path, and so there is nothing to leak through.

`edit` in this order, pasting according to the rendering map in `references/deck-json.md` at each step,
with the complete samples you can copy from in `references/layout.md`:

0. **One `edit`**: the `data-hero` of `div.hero-band` at the start of `<body>`, filled from the JSON's `hero`
   (on its own, because this block sits before `<div class="deck">` and is not adjacent to the next one).
1. **One `edit`**: the `.toc-sub` concept entries inside `<nav class="toc">`
   + ① the header's `h1` / `p.meta` / `p.for-whom`.
2. **One `edit`**: ② the knowledge map (drawing that SVG on the spot from `map.sketch`) + ③ the primer.
3. **Chapters, one `edit` call per chapter**: `oldText` is the single line
   `<!-- ④-ANCHOR insert concept chapters before this line ⟨待填⟩ -->`,
   and `newText` = this chapter's "curtain page + `.concept`" pair + that same comment line.
   **When inserting the last chapter, do not bring that comment back** — the anchor should disappear once used, it carries `⟨待填⟩`,
   and leaving it in gets caught by 5.6's self-check H1.
4. **Handle ⑤ after every chapter is inserted**: if `compare` has content, fill it in;
   if `compare` is `null`, delete the whole of ⑤ along with the "Method comparison" entry in the contents.
5. **One `edit`**: ⑥ the summary, ⑦ the glossary, ⑧ what to do next, ⑨ the references, ⑩ the honest boundaries.

⚠️ **The ids of ⑨ the references have to be thought through before the body's `source[]`**: body citations are now **two hops**
(body `<a href="#r-xxx">` → that `<li id="r-xxx">` in ⑨ → the paper's own URL),
and the `source[]` pasted out at Steps 2 and 3 refers to exactly those ids from Step 5. One missed is one
dead link that does nothing when clicked, and H4 will catch it. How to write it is in `references/layout.md`, "⑨ References and the two-hop citation".

- **Hand-off**: go to 5.6 once rendered. If some chapter's **content** turns out wrong mid-render, **go back to the JSON** (see hard constraint 6),
  do not change your mind in place on the HTML. **How a figure is drawn** (boxes do not fit, a line came out crooked, the wrong class) is the exception:
  change that `<svg>` right there in the HTML — the JSON never had the drawing in it anyway.

### 5.6 HTML-layer self-check, then deliver

- **Input**: the rendered HTML.
- **Output**: a report ready to deliver.
- **How**: run the 4 groups of commands in "Pre-delivery self-check · HTML layer" in `references/layout.md`,
  **once** — the structural criteria were already verified on the JSON at 5.4, and only the few that hold after rendering are checked here.
  On a hit, go back to the JSON, fix it, re-paste that spot, then **re-run only the group that hit**.
- **Leave `.learning-deck-*.json` in the project, do not delete it.** It sits alongside the report: when the template improves later
  it can be re-rendered from it, and a user who wants one sentence changed does not have to redo the interview and the searching. KyDog's file tree does not show files
  beginning with a dot, so it will not crowd the tree on the left.

**Do not restate the report's content in the conversation** — it is already in the file, and finishing produces a clickable file card that opens it directly; the user can also double-click that `.html` in the file tree on the left. Give four sentences only:

1. This report's **starting-point picture** (from the interview: which layer you already stand on, so which blocks we covered)
2. **The section to read first**, and why that one
3. **The file path**
4. **How to make changes** — one sentence making clear "change the JSON first, then the corresponding HTML",
   and **write out the JSON's path** (`.learning-deck-<slug>-YYYY-MM-DD.json`, sitting next to the report).

⚠️ **Sentence 4 may not be omitted.** Now that 5.2 no longer stops to ask about the outline (see the note at that sub-step),
**the delivery message is the only calibration entry point**. Writing the procedure into SKILL.md does not count — the user will not go and read a skill,
all they have is this message from you. KyDog's file tree does not show files beginning with a dot either, and without the path written out they cannot find that JSON.

One version to copy from (with the slug and date replaced by the real ones):

> Just tell me if you want changes. The report's content is all in `.learning-deck-ecg-fm-ami-2026-08-21.json`,
> so changing a sentence means changing that JSON first and then applying the same change in the HTML; deleting a chapter, adding one or reordering them is fine too,
> and for that kind of change I go back to the JSON, make the change, and re-render the affected chapter. Do not edit the HTML directly — the JSON would go out of sync.

---

## Hard constraints

Missing any of the first four **fails silently** — the report still gets written, it just comes out wrong when opened in KyDog, and you get no error at all:

1. **Use only the one `<script>` block at the end of the template; do not open a new `<script>` tag.** The viewer sandbox now grants
   `allow-scripts`, so scripts run (arrow-key paging, items entering one at a time, SVG stroking, contents highlighting,
   and the cover band at the top all depend on it);
   new logic goes into that one place, do not start another tag.
2. **Do not pull in any external resource**: CDN, Google Fonts, unpkg, `<link rel=stylesheet>`, `@import`,
   webfonts, `<img src="http…">`, a `url()` in CSS pointing at the network, or
   `fetch` / `XMLHttpRequest` / `WebSocket` in the script — the sandbox also injects a strict CSP
   (`default-src 'none'`, `connect-src 'none'`, `img-src data:`),
   and **all of the above get blocked, so writing them is wasted effort, and the page merely comes out missing a piece with no error**.
   So reference images by a relative path inside the report's directory tree, `<img src="papers/…">`; the viewer reads the file at render time
   and inlines it as a `data:` URI — do not encode base64 yourself, see `references/figures.md`.
3. **Every external link takes `target="_blank" rel="noopener"`.** The sandbox does not grant `allow-top-navigation`, so a plain link tries to navigate in place inside the iframe when clicked. An `<a href="https://…">` pointing at a paper is a link, not a resource, and is allowed; loading it as a resource (`img` / `link` / `@import`) is not.
4. **Every color is written in the form `var(--ink, #2a2620)`, with a fallback**, and variable names may only come from the list in the template's header comments. A report with hard-coded colors is blinding under the midnight theme; a variable name outside the list always falls through to the fallback, which is the same as hard-coding.

The rest are operational and content discipline:

5. **The report HTML and the `.learning-deck-*.json` may only be changed with `edit`.**
   There are exactly two whole-file operations, and only these two: `cp` the template into the HTML (sub-step 5.5),
   and `write` the JSON skeleton (sub-step 5.1). After that both files take only `edit`.
   **`python` / `python3` / `perl` / `sed` / `awk` / `node -e` may never be used to change these two files**
   — neither for in-place regex surgery, nor for "assemble the whole `<body>` into a string and write it back".
   **Nor may a script be used to "just validate, read-only" the JSON**: `node` does exist inside Electron, but once you open the door to
   "validation may use a script", the lesson of the last two times is that it grows into "and so may modification".
   Only a simple rule with no exceptions holds; and the JSON is small enough to read, so no script is needed.
   Two reasons, and this discipline does not hold without either one:

   1. **KyDog does not guarantee the user has these runtimes.** We only bundle fastpaper, no language runtime at all;
      `python3` runs on your machine and may simply be a 127 on the user's. This is the same class of thing as `rg`
      (see item 8), only it fails later — with the report already half written.
   2. **It goes around `edit`.** `edit` replaces one place at a time and **errors** when it cannot match; changing a file with a script hands
      the whole artifact to one string concatenation, and when that goes wrong it **raises no error** — the file is still there, still opens, just missing a section.
      This is not hypothetical: v1's `perl -0777 -i -pe 's/\n<div hidden aria-hidden="true">.*…/s'`
      ate a whole passage; v3's was `python3 -c '…p.read_text()…body="""<body>…'`, which
      **rewrote the entire `<body>` twice**. The same mistake made once in each of two languages.

   ⚠️ What this bans is **changing those two files**. The `sed` in the H4 pipeline of "Pre-delivery self-check · HTML layer"
   in `references/layout.md` (trimming grep's output down to ids) is read-only; just copy it,
   it is outside the scope of this ban.
6. **The HTML is an artifact. When something looks wrong after rendering, work out which of three kinds it is before touching anything.**

   | What is wrong | Where to fix it |
   |---|---|
   | **Content** — a passage, an example, a line of inline markup, plus adding / deleting / reordering blocks | **Go back to the JSON**, then sync it into the HTML |
   | A figure's **intent** — which step it should show, the caption, the figure number `num`, the credit `credit` | **Go back to the JSON** and change `sketch` / `caption` / `num` / `credit`, then **draw the figure again** and paste it back into the HTML |
   | A figure's **drawing** — the SVG markup itself: boxes not fitting, a crooked line, an id collision inside `<defs>`, the wrong color class | **Change that `<svg>` right there in the HTML**, leaving the JSON alone |

   The last row is not an exception, it is that **the JSON has no such thing as a drawing in it** (SVG does not go into the JSON, see Step 5).
   Adjusting a figure's lines on the HTML does not put the JSON out of sync — the JSON says "draw a timeline,
   with four ticks on it", and that sentence is still true after you have straightened the lines.

   How to fix the first two rows:

   - **Changing a passage / a line of markup** — change that line in the JSON first, then paste **the same `oldText` /
     `newText`** into the HTML. Two `edit` calls, and the second is a copy-paste of the first (those array elements in
     the JSON and the lines in the HTML are identical word for word, indentation included, see `references/deck-json.md`).
   - **Adding / deleting / reordering blocks (all within one chapter)** — go back to the JSON, make the change, then re-render **that one chapter**.
     A chapter is a hundred-odd lines, not the whole report.
   - **Deleting a chapter / inserting a chapter / reordering chapters** — that is a different thing, do not handle it as the line above. Re-rendering the chapter is only
     one step of it; you also have to change the **numbering** (`§N` continuous through the report), the **`id`** (`id === "c" + number`),
     the **contents entries**, the **knowledge-map nodes**, the **in-page anchors**, the **figure numbers**, and the glossary's **`where`**.
     Work through "Changing the structure afterwards: delete a chapter / insert a chapter / reorder" in `references/layout.md` step by step;
     it lists every one of those places.
   - **Changing a figure's intent** — there is no copy-paste discount to be had: the `sketch` changed, so the figure has to be redrawn to the new `sketch`.
     This is the openly stated price of "SVG does not go into the JSON"; do not skip the trip by changing only the caption on the HTML.

   **Except for the figure-drawing cell, changing the HTML without changing the JSON is not allowed.** Once the JSON is out of sync with the content
   it becomes a lying archive, and re-rendering from it next time gives a report different from the one the user has
   — with no error either. (A figure was never going to re-render identically; that is a known, openly stated price;
   a body that does not match is a straightforward accident.)
7. **Positions not yet rendered stay where they are; "hiding" them is not allowed.** Do not stuff something not yet filled into a `<div hidden>`
   or an `aria-hidden="true"` to deal with later. Why: hidden content is still in the file,
   ⌘F finds it, it may show up when exporting to PDF, and you will end up writing a regex to delete it — which is exactly item 5.
   If you cannot finish a section, leave it alone for now (that `⟨待填⟩` comment stays as it is, and self-check H1 will list it),
   and replace it in one go once it is finished.
   ⚠️ The template itself has three `aria-hidden="true"` occurrences (the header cover band `.hero-band`, the contents caret
   `.toc-caret`, and the separator dot `.meta-sep` in the meta line), which are **the correct use for purely decorative elements**
   and are kept as they are — what this item bans is using it to hide content.
8. **The HTML-layer self-check always uses `grep`.** KyDog does not bundle ripgrep, so `rg` returns 127 without fail, three tries included.
   The command list is in "Pre-delivery self-check · HTML layer" in `references/layout.md`; **copy it, do not improvise**.
   (The line in the system prompt about "use bash for ls / rg / find" has already been changed to `grep`, see
   `src/main/agent/systemPrompt.ts` — this discipline is no longer the only line of defence, but it is kept all the same.)
9. **A redrawn figure must be labelled "Redrawn from XX (year) Fig.N" + an external link, and an original may never be passed off as your own drawing, nor your own drawing as an original.**
   Scatter plots, heat maps, survival curves and the like are **data figures and are never redrawn** — turn them into a pointer card instead. Details in `references/figures.md`.
10. **Do not create directories, do not write scripts, do not leave intermediate files** (`-o` included); **not one DOI may be invented**, and every paper is verified back at source with `fastpaper get`.
    ⚠️ `.learning-deck-*.json` **is not an intermediate file**, it is a deliverable sitting alongside the HTML, kept after delivery (sub-step 5.6).
11. **Write in the language the user speaks.**

## The report's structure

Three concentric rings: the map first, then the prerequisites, then the body, and finally the summary and appendices.

```
① header   ② knowledge map   ③ primer
④ concept body (the main part, one section per key concept, each preceded by a full-screen curtain page)
⑤ method comparison table   ⑥ summary section   ⑦ glossary table   ⑧ what to do next   ⑨ references   ⑩ honest boundaries
```

⚠️ **v4's ③ "fast track" has been deleted** (the user's judgement after the fourth real run: "it serves no purpose at all" —
the chapters are already ordered by dependency and the contents already put that order on the left, so it only listed the same string of titles again in different words).
The numbering therefore moved up one place, and the `path` field in the JSON was deleted with it. Do not restore it per the old version.

Three judgements at the process level:

- **Which sections ④ gets is decided by the interview**, not by the topic's "completeness". Concepts marked "familiar" get no body section,
  and appear only in ② the knowledge map as already-known nodes.
- **⑤ exists only when the topic is "a method"**: its assumptions / where it applies / cost / failure modes against 2–3 alternatives.
- **⑥ the summary section may not be skipped.** The reader has to have a moment where it "comes together" at the end, rather than finishing with a pile of parts —
  that is the difference between this report and a stack of handouts. (v4 called it "wrap-up"; v5 renamed it, because that was jargon the reader does not follow.)

**①–⑩ correspond one to one with the JSON's top-level fields, and what shape each block should take is in `references/deck-json.md`;
the class each block renders into and the fixed order within a section are in `references/layout.md`;
what each slot should look like is in `references/writing.md`.**

**At least one mechanism figure per key concept.** If you cannot get far enough to need a figure, this section has not been thought through,
or it belonged in the primer all along.

## Honest boundaries

Section ⑩ is not a disclaimer, it is the basis on which the reader judges how far this report can be trusted:

- **Not found ≠ does not exist.** State plainly which sources and which terms turned up nothing. A self-study report's reader is outside the circle and is the least able to spot a gap unaided, which makes this matter more here than in the other skills.
- **A preprint must be labelled a preprint.** The reader has a right to know it has not been peer reviewed.
- **Not one id may be invented.** Every DOI / arXiv id / PMID has to be confirmed back at source with `fastpaper get`. If it cannot be, that entry does not get written.
- **Every figure's origin has to be accounted for**: which are original figures, which are redrawn (from which paper, which figure), which are entirely your own, which could not be used because of format or size, and whether the current model can see images.
- **Which claims rest on abstracts only, and which are your summary rather than the literature's own words**, listed item by item, not glossed over with a blanket "parts of this are based on abstracts".
