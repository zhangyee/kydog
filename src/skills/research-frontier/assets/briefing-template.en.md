# Frontier Briefing on <direction>

> Covering <YYYY-MM> to <YYYY-MM> (<N> months) | <N1> sources, <N2> queries | <N3> papers entering the briefing,
> of which <N4> preprints | <N5> verified against full text, the rest abstract only

<date>

> **The reader is by default an insider in this direction.** Do not explain what the direction is, do not define existing terminology, do not lay groundwork for why it matters.
> 900–1500 words in all. Written long it slides toward a review, and a review is `/literature-review`'s job.
> Where the time window was widened (12 months turned up nothing), state in the line above how far it was widened.
>
> **On a paper's first appearance write "Author (year), Title"**, and only on later mentions shorten it to "Author (year)".
> This briefing's body has no reference list next to it; with author and year alone the reader cannot tell which paper it is, nor recall
> whether it appeared earlier. No need to repeat it where a table already has a title column. **Preprints are marked on first appearance.**
>
> **Titles must be reproduced in full, no truncating with an ellipsis, no shortening of your own.** The reader takes that title away to search with,
> and a truncated one finds nothing. Copy a 180-character title too — that is what the source says.

---

## Core judgments

> 3–5 items, each one sentence + a paper hung on it. The reader may read only this passage, so it must stand on its own.
> Each must be a **judgment**, not a description — "X has appeared" is a description, "X ends the cost advantage of route Y" is a judgment.
> Inference and what the literature states must be labeled apart.

1. …(author year)
2. …
3. …

---

## 1. Recent significant advances

> Group by **where the newness lies**, not by chronological sequence. Preprints must be marked.
> The criterion: an insider reading it says "I had not noticed that", not "I know that".

**New method**

**New data or new setting**

**New result**

---

## 2. Revisions to established conclusions

> This section is worth the most to an insider — they already hold a map, and most want to know where it needs changing.
> **Write them in pairs**, and the degree of destabilization must land on one of the three grades, not blur into "has been challenged".

| Established conclusion | New evidence | Degree of revision |
|---|---|---|
| …(old paper) | …(new paper) | overturned / scope of applicability narrowed / a first counterexample has appeared |

> If no assumption was shaken in a year, write "none found" and keep this section — that means the direction is converging rather than opening up,
> and it is a conclusion worth stating.

---

## 3. Principal research groups and their research trajectories

### Groups working the direction continuously

> **Write a trajectory, not a paper list.** For each group pick 2–4 waypoints that let a reader see what they went from and to.
> "What makes them a leader" needs grounds: repeatedly pointed at by citation chains, having defined a task or a benchmark, written into a guideline or consensus statement.
> "Publishes a lot" is not grounds.

**<group / PI (institution)>** — <N> years on this direction

<year> <what they did> → <year> <what they did> → <year> <what they did>

**Where the trajectory points**: <what their track says about where the direction is going>

**Movement in the past year**: <what they are doing next>

### Groups newly entering the direction

> Above all those migrating in from another discipline. An old group publishing more papers is not news; a signal-processing group starting on clinical endpoints is.

**<group>** — came from <which field>, brought <what method>, <why this migration may work out>

---

## 4. Newly emerged terminology

> Each new term must be followed by a line on "what it finds that the old words do not".
> This is the only part of the briefing that directly improves the reader's own searching, more useful than listing a few more papers.

| Term | What it refers to | What it finds that existing vocabulary does not |
|---|---|---|
| | | |

---

## 5. Open controversies

> **Write them in pairs**: who concluded what, who is on the other side, where the disagreement may come from (population / measurement / task definition / statistical convention).
> The defining feature of a frontier is that there is no consensus yet. If everyone agrees, it is no longer a frontier but a consensus —
> and that is itself worth naming.

**Point of contention: <what>**

- One side: <paper> — <conclusion>
- The other side: <paper> — <conclusion>
- Likely source of the disagreement: <…>

---

## Appendix: Search and verification

**Search**

| Source | Queries | Hits | Entered the briefing |
|---|---:|---:|---:|
| | | | |

- Time window: `--after <date>`; where it was widened, state the reason
- Cross-disciplinary entry points: <which sources and categories were used>
- Citation heat: `semantic --after … --sort citations` was used to take "recently published and ranking high on citations" work.
  **This briefing carries no citation-growth data** — `cite` can only truncate its sample, so what comes out is the parameter, not heat.
- Extreme-value re-verification of in-query filters: <result>

**Paper list**

> The briefing body gives only "Author (year), Title", and a reader who wants the source needs the DOI. **This table cannot be dropped** —
> a briefing saying "you missed these" is as good as unwritten if the reader cannot get hold of those papers. Ordered by first author alphabetically.

| Paper | Title | Year | Type | DOI / id | Verification level |
|---|---|---:|---|---|---|
| Author et al. | | | journal / preprint | | full text / abstract only |

**Verification**

All <N> were traced back to source one by one with `fastpaper get`; <N> removed for <reason>; <N> metadata corrections.
<N> verified against full text, the rest backed by abstract alone — **the claims backed by abstract alone are listed one by one here**:

- <claim> — <paper>, abstract only

**Full-text acquisition**: <N> downloads initiated, <N> succeeded; <N> failed, with the error text <listed one by one>.
Another <N> were already in `papers/`.

**The boundaries of this briefing**

- Sources covered: <list>. Not covered: <list>, so <some category of literature> may have been missed.
- Preprints account for <N>/<N>, not peer reviewed.
- No download-count data, no publication-volume trend data, no coverage of clinical trial registries.
  Any "importance" judgment in the text is a proxy, and is labeled as such.
