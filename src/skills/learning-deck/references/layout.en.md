# Layout and components · layout.md

The template `assets/report-template.html` already defines every style. This volume only writes
**"what this block looks like, when to use it, and what goes inside it"**, and does not repeat the CSS in the template —
do not change one character of the styles.

⚠️ **Since v5 the template's `<body>` contains no example content at all** (none whatsoever: not just the chapters,
but the knowledge map, the primer, the glossary, the references… all reduced to a single placeholder comment carrying `⟨待填⟩`).
So **the complete samples you can copy from are now all in this volume**, in the two sections below, "② The knowledge map: one finished figure"
and "④ What one finished chapter looks like". Why it was changed this way is at the start of the "④ The concept body" section.

**Do not invent classes.** A class name that is not in the template gets no styling at all, and comes out as a run of bare text,
**with no error**. Likewise **do not add inline `style` to the body** — with no exceptions: not even on an `<img>` embedding an original figure,
because the template's `figure img` already handles scaling.

---

## The skeleton of the whole report

```
<div class="deck">                            ← three-column grid: contents | body | margin-note track
  <nav class="toc">                           navigation tree on the left (entries are hand-maintained)
  <main class="flow">                         the body column, one per report
    <header class="deck-head">        ① header
    <section class="map"      id="map">        ② knowledge map
    <section class="primer"   id="primer">     ③ primer
    <div class="curtain" id="c1">              curtain page · section 1 (the chapter anchor lives here)
    <section class="concept">                  ④ concept body · section 1 (no id, no h2)
    <div class="curtain" id="c2"> … <section class="concept"> …   (one pair per section)
    <section class="compare"  id="compare">    ⑤ method comparison table (only when the topic is "a method")
    <section class="summary"  id="summary">    ⑥ summary section
    <section class="glossary" id="glossary">   ⑦ glossary table
    <section class="next"     id="next">       ⑧ what to do next
    <section class="refs"     id="refs">       ⑨ references
    <section class="honesty"  id="honesty">    ⑩ honest boundaries
  </main>
</div>
<script> … </script>                                         ← the only script block in the file
```

⚠️ **A newly added `<section>` must carry an `id`.** The arrow keys' stopping points are
`.curtain, .concept, section[id]`, those three; a bare `<section>` matches none of them and
the arrow keys skip straight past it — no error, the reader just finds this screen "unreachable".
**The one exception is `.concept`**: it is selected directly by class, so it needs no id —
the chapter's anchor is on the curtain page in front of it (see "The curtain page" below).

⚠️ **Do not put `style`, `position` or `overflow` on `.flow` or `.deck`.**
`position` moves the reference frame of `.curtain` / `.concept` `offsetTop` from the document onto that element
(the arrow keys land off by a whole offset); `overflow` relocates document scrolling (and scroll-snap fails with it).
Neither raises an error.

### The four v5 changes (do not restore them from the old wording)

| What changed | Now | Why |
|---|---|---|
| The top progress bar `.progress` | **deleted** | `.is-current` in the left contents already gives a sense of place, while a progress bar needs a permanent grey track in order to show progress, which makes the top of this tab inconsistent with the other tabs |
| ③ the fast track `.path` | **deleted** | The chapters are already ordered by dependency and the contents put that order on the left; it only listed the same string of titles again in different words |
| ⑦ the wrap-up section | renamed **⑥ summary** (class / id / JSON field are all `summary`) | "Wrap-up" was jargon the reader does not follow |
| ⑩ the literature list | renamed **⑨ references**, and body citations became **two hops** | See "⑨ References and the two-hop citation" below |

So the numbering went from ①–⑪ to ①–⑩.

---

## Three columns and how they degrade (v3)

`.deck` is a three-column grid: **contents on the left + body in the middle (locked to 38em ≈ 35 Chinese characters / 67 Latin characters per line)
+ a margin-note track on the right**. When the width runs short it degrades at measured breakpoints, and **you have to do nothing, just add the right class**:

| Report panel width | Form | Contents | Body column | `.aside` |
|---|---|---|---|---|
| ≥ 1180px | three columns | sticky tree on the left | 570px (35 Chinese characters) | Tufte margin note floated right |
| 820–1179px | two columns | sticky tree on the left (narrowed) | 570px | block level, flowing inline with the body |
| < 820px | one column | **not shown** (v7, see the ⚠️ below) | 570px centred, adapting when the panel is narrower | block level |

⚠️ **Under KyDog's default window (1280px, session list on the left + Inspector on the right) the report panel is only about 738px,
which lands in the single-column tier.** Three columns need a wider window or one panel collapsed. Do not think three columns is broken.

⚠️ **The narrow tier (< 820px) does not show the contents; that was the user's call in v7, not a broken template.** In v3–v6 this tier
degraded the contents into a sticky pill-shaped bar above the body, and in real runs the entries were cut off by the right edge
(`§2 Building samples from patients, visits and multiple E…`), so reading one in full took a horizontal drag; it was deleted.
**Navigation in the narrow tier therefore rests entirely on the body itself** — you must write all of these, and one missing means the narrow tier really has no way to jump:
② the knowledge map (`#map`, nodes pointing at each chapter's `#cN`), **the line at the end of every chapter,
`<p class="back"><a href="#map">↑ Back to the knowledge map</a></p>`**, the arrow keys / `Home` / `End`,
cross-references in the body such as "see §2", and the glossary's "first appears in".

⚠️ There are two **deliberate reversals** here relative to v1/v2, also written in the template comments; do not change them back to the old wording:
1. v1/v2 explicitly ruled out a "fixed floating contents panel" — **we now do it** (`.toc` is one column of the grid,
   not a fixed panel floating over the body, so it cannot obscure anything).
2. v2 had the body "match the Markdown tab and take no width limit", with the trailing "known cost: 70+ Chinese characters per line" —
   **both are void**, and the body is back to a fixed width.

---

## Interactive components (the template script is already wired; you only add classes)

### `.toc` — the navigation tree on the left

There is one in the template already; **do not write a second one and do not delete it**. The collapse button and the current-item highlight
(`.is-current`) are wired by the script at the end of the file, and **the one thing you have to do is change the entries to this report's real chapters**:

```html
<nav class="toc" aria-label="Chapter navigation">
  <button class="toc-head" type="button" aria-expanded="true" aria-controls="toc-body">
    <span class="toc-caret" aria-hidden="true"></span>Contents
  </button>
  <div class="toc-body" id="toc-body">
    <ol class="toc-list">
      <li><a href="#map">Knowledge map</a></li>
      <li><a href="#primer">Primer</a></li>
      <li>
        <div class="toc-group">Concepts</div>
        <ol class="toc-sub">
          <li><a href="#c1">§1 …</a></li>   ← one entry per section; href points at the curtain page
        </ol>
      </li>
      <li><a href="#compare">Method comparison</a></li>
      <li><a href="#summary">Summary</a></li>
      <li><a href="#glossary">Glossary</a></li>
      <li><a href="#next">What to do next</a></li>
      <li><a href="#refs">References</a></li>
      <li><a href="#honesty">Honest boundaries</a></li>
    </ol>
  </div>
</nav>
```

⚠️ The entries and the anchors in `.flow` are **one to one, maintained by hand**: one missing raises no error,
that section simply disappears from the contents; an `href` pointing at an id that does not exist raises no error either, clicking it just does nothing
(check with H4 of "Self-check · HTML layer" before delivery, which lists unreachable anchors directly).
⚠️ The concept entries point at the **curtain page** (the `id` on `.curtain`), not the body `.concept` —
clicking §1 should enter this section through its cover.
⚠️ **When `compare` is `null`, delete the "Method comparison" entry together with that whole section in the body.**
Deleting only one side leaves a dead anchor that does nothing when clicked.
⚠️ Concept entries write `§N Title`, and the other entries **write the name only, unnumbered**, see "Numbering notation" below.
⚠️ `aria-expanded` / `aria-controls="toc-body"` and the `id="toc-body"` on `.toc-body`
must be kept as a pair; `aria-current="page"` on the current item is set by the script and is not yours to write.
⚠️ Only the concept group nests one level with `.toc-sub`; do not turn all of ①–⑩ into a tree.

### Arrow keys / scroll-snap

`↓` `→` next section, `↑` `←` previous section, `Home` / `End` to the start and end.
`.curtain` and `.concept` take part in scroll-snap; auxiliary sections do not snap but are still arrow-key stopping points.
**None of this needs anything from you**; add the right class and it is automatic.

### `.reveal` — entering one item at a time

Fades in and rises when it enters the viewport. **Put it on "blocks", do not add it paragraph by paragraph to body `<p>`** —
fading in one paragraph at a time makes reading feel stuttery. Fixed to these places, copy them:

```
aside.aside · div.example · div.boundary · div.source · p.checkout
```

`.reveal` elements under the same direct parent enter staggered in turn, **capped at 6** (from the 7th on no further delay accumulates).
So do not stuff a dozen `.reveal` elements under one parent; the later ones would bunch up.

The three parts of the curtain page take no `.reveal` — it is the reader's first sight of this section, and a fade-in makes it look like it failed to load.

### `.draw` — SVG stroke animation

Strokes lines out in order. **Only put it on lines**: `<path>` `<line>` `<polyline>`.
Putting it on `<rect>` or `<circle>` raises no error (they have `getTotalLength` too),
but the effect is a stroke tracing the outline, which reads wrong. Text takes no part in stroking; if you want text to fade in, give it its own `.reveal`.

`.draw` elements inside one `<svg>` stagger in turn, likewise **capped at 6**.

You use it by stacking it on the line class already there:

```html
<path class="arrow-line draw" d="…" marker-end="url(#ld-arrow)"/>
```

A path that already expresses dashed semantics through `stroke-dasharray` **must not also take `.draw`** — the two fight
(the stroke animation overrides that attribute with an inline `style.strokeDasharray`, and once the animation finishes the dashes turn solid).

### The header band `.hero-band`

Already in the template. It is a **direct child** of `<body>` (before `<div class="deck">`), not inside
`.deck-head` — bleeding to full width needs that position, so do not move it in. Inside it, `canvas.hero-canvas`
is the animated layer and `svg.hero-fallback` is the backstop for when that fails to start; neither may be deleted. It is pure decoration
(`aria-hidden="true"`), and no information may be drawn only here. **Do not copy it anywhere else** —
only the header uses WebGL / canvas, and the reason is in "Explicitly not doing" below.

**Keep the whole block as it is; the one thing to change is the `data-hero` value**:

```html
<div class="hero-band" data-hero="gridwave" aria-hidden="true">
```

Three legal values — `gridwave` (scan lines · HUD) · `constellation` (constellation of knowledge) ·
`holoband` (holographic dispersion). Take the `hero` field at the top of the JSON; how it is derived from the topic slug is in
SKILL.md sub-step 5.1. A typo, some other value, or the attribute missing entirely all fall back to `gridwave`
(a determined backstop, not a random one).

⚠️ **Do not delete this band.** The header's `h1` / `p.meta` / `p.for-whom` use
`--hb-fg` in the template CSS (a light color on a dark band). Delete the band and the title is a light color on light paper — **invisible, and with no error**.

⚠️ **Changing the face means changing only this one value** (`hero` in the JSON and `data-hero` in the HTML kept in step),
with no need to re-render the whole report.

---

## The curtain page `.curtain` — the chapter's title, number and anchor all live here

```html
<div class="curtain" id="c1">
  <div class="curtain-num">§1</div>
  <h2 class="curtain-title">Normalize per lead or per whole record</h2>
  <p class="curtain-lede">…the one-line definition…</p>
</div>
```

One screen tall, with nothing but a large chapter number + the title + the one-line definition. It is a `<div>`, not a `<section>`.

⚠️ **The chapter's `id` is on the curtain page, not on `.concept`.** The "§1 …" in the contents,
the knowledge-map node and the "see §2" in the body all point at that id — clicking through should land the reader on the cover,
entering this section from its beginning. `.concept` carries no id (the arrow keys select it by class, see the ⚠️ above).

⚠️ **The curtain page carries this section's entire title and numbering, and neither appears again in the body.**
`.concept` has **no `<h2>`** and **no `.counter`**: the first element of the body is `.lede`,
and the first heading is the `<h3>` reading "What problem it solves".
The reason came out of a real run: when v2 added curtain pages it only de-duplicated the "one-line definition", leaving two copies each of the title and the number,
with the number in two notations (`01` on the cover vs `item 1 / 4` in the body); the user's words were
"I thought there were 4 points under chapter one, and only worked out much later that there were 4 chapters in total".
The cost is that scrolling into the middle of a chapter leaves no chapter name on screen — compensated by the current-item highlight in the contents on the left; a trade-off, not an omission.

⚠️ **`.curtain-lede` and the `.lede` inside the `.concept` right after it are the same sentence, and must be word for word identical.**
This is the "one-line definition at the head of the section" presented in two places (shown enlarged on the cover once, seen again on entering the body),
**not one sentence written for each, and not split into halves to avoid repetition**.
The JSON writes it only once (`chapters[].lede`) and pastes it into both at render time, which makes this one **structurally impossible to break**.

### Numbering notation: only `§N` throughout

| Where it appears | Written as |
|---|---|
| `.curtain-num` on the curtain page | `§1` |
| Entries in `.toc-sub` | `§1 Normalize per lead or per whole record` |
| The subtitle of a `.n-focus` node in ② the knowledge map | `to cover · §1` |
| Cross-references in the body / margin notes | `see <a href="#c2">§2</a>` |
| `.where` in ⑦ the glossary | `first appears in §1` |

⚠️ **`§` is reserved for ④ the concept chapters.** Auxiliary sections such as ⑤ the method comparison and ⑥ the summary **take no number** —
in the contents they get only a name, and the order is expressed by the list itself.
When citing a section of a paper, write "sections 2–3 of the original", not `§` again.

⚠️ **Do not write `01` / `Chapter 1` / `item N of M`.** "The cover says `01`, the contents says `§1`",
two notations for one thing, is exactly what was unified this time.

---

## Changing the structure afterwards: delete a chapter / insert a chapter / reorder

**This section is the main road after delivery.** SKILL.md sub-step 5.2 no longer stops to confirm the outline with the user,
so "the chapters are wrong" will only be discovered **after the report has been delivered** — and the remedy at that point is this section.

Changing a sentence is cheap (one `edit` on the JSON, then the same `oldText` / `newText` pasted into the HTML,
two calls); **changing the structure is not**: chapter numbers `§N` are continuous through the report, `id === "c" + number`,
and the contents entries, the knowledge-map nodes, the in-page anchors, the figure numbers and the glossary's `where` all move with them.
The "Numbering notation" table above is that checklist: **wherever `§N` appears is what has to change.**

Three general rules, read them before you touch anything:

- **Always change the JSON first, then the HTML. Do not say it is done until both sides are done.**
  Changing only the HTML turns the JSON into a lying archive, and raises no error (SKILL.md hard constraint 6).
- **Renumbering has a direction**: **when deleting a chapter go from small to large** (the old number is already vacated, so nothing collides);
  **when inserting go from large to small** (take the last chapter N→N+1 first, then N-1→N…).
  Get the direction wrong and a new number collides with an old one not yet changed, so `edit` matches the wrong place — **and raises no error**.
- **Changing a chapter number does not require re-rendering that chapter.** The body `.concept` has no `<h2>` and no `.counter`
  (see "The curtain page" above), so the number lives only in the curtain page's `id` and its `.curtain-num`;
  those two sit next to each other and one `edit` swaps both. The only chapter that really has to be re-rendered is **the newly inserted one**.

### Deleting §K (out of N chapters)

**JSON (`.learning-deck-*.json`), do not skip a single step:**

1. Delete item K from `chapters[]`.
2. **For every chapter from K+1 to N**: subtract 1 from `number`, and set `id` to `"c" + the new number` (J-A 1 requires the two to agree,
   so changing only one is not allowed). Those two fields are adjacent lines, and **one `edit` per chapter** swaps both. **Go from small to large.**
3. **Search the whole file for `#c`** (`grep -n '#c' .learning-deck-<slug>-<date>.json`, read-only, permitted):
   every `href="#cX"` and the `§X` literal next to it follow the new numbers
   (they occur in `lede` / `aside` / `blocks[].html` / `blocks[].intro` / `boundary[]` /
   `source[]` / `checkout`). **No reference to the deleted chapter may remain** — either redirect it somewhere else,
   or delete the whole sentence.
4. `map.sketch`: delete the `state: "focus"` node with `href: "#cK"`, and every entry of `edges[]` mentioning its
   `label` at either end; the `href` of the remaining nodes follows the new numbers.
   Read it through once you are done: has any node become isolated as a result? Is the edge that `emphasis` talks about still there? If it is, keep it; if not, rewrite it.
5. `glossary[]`: for the entries whose `where` is `§K` — whichever section that term now first appears in among the remaining body,
   `where` becomes that section; **entries that only ever appeared in the deleted chapter get deleted entirely** (a word not in the body should not occupy the glossary).
   Every other `where` greater than K has 1 subtracted.
6. **Figure numbers**: `num` counts continuously from 1 (the one in `map`) (J-B 10). However many figures the deleted chapter had,
   every `figure.num` after K has that many subtracted.
7. `references[]`: for every `r-` id cited in the deleted chapter's `source[]`, search the whole file again —
   if nothing else cites it, delete that entry (J-E 18: listing a work nothing cites means it did not make it into this report).
8. Recompute `readingMinutes` (algorithm in the top-level section of `deck-json.md`).
9. Sentences in `summary` / `next` / `primer` / `honesty` / `forWhom` that name that chapter get fixed one by one.
10. Re-run the **J-A / J-C / J-D** groups of the JSON self-check (numbering, anchors, notation — exactly what this pass touched).

**HTML (the report `.html`), one place for one place:**

1. **One `edit` deletes that chapter**: `oldText` runs from `<div class="curtain" id="cK">` all the way to that chapter's
   `.concept` `</section>` (the `<p class="back">` at the chapter's end is inside `</section>`,
   so it goes with it), and `newText` is empty. The curtain page and the `.concept` are a pair,
   and **deleting only half makes the two counts in self-check H1 unequal**.
2. **Every chapter after K changes in two places**: the `id="cX"` on `.curtain` and the `§X` in `.curtain-num`.
   Those two lines are adjacent, one `edit` per chapter. Not one word of the body needs touching.
3. **`.toc-sub`**: one `edit` replaces the entire `<ol class="toc-sub">`, with the entries rewritten from the JSON
   (delete the §K entry; the rest have their `href` and `§N Title` follow the new numbers).
4. **The SVG of ② the knowledge map**: delete the `g.node` of the deleted chapter (along with its `<a href="#cK">`, `rect`,
   `text` and the subtitle `to cover · §K`) and the `.edge` at either end connecting to it; for the remaining nodes, the `<a href="#cX">`
   and the subtitle `to cover · §X` each follow the new numbers. **With one node fewer the figure has a hole in it**, and whether the remaining nodes should
   be moved follows `map.sketch` and is redrawn — that is "how the figure is drawn", and is changed on the HTML anyway (SKILL.md hard constraint 6).
5. **Cross-references in the body**: `grep -n 'href="#c' <report>.html`, then check line by line against the JSON.
6. **`.where` in ⑦ the glossary** (`first appears in §X`), the `<li id="r-…">` in **⑨** that has to go, and
   the "about M min" in **①** `p.meta`, one `edit` each.
7. Re-run **H1** of "Pre-delivery self-check · HTML layer" (curtain count = `.concept` count = the JSON's chapter count)
   and **H4** (unreachable in-page anchors, should be 0 lines). **H4 is the main check for this pass** —
   miss one place in any item above and the result is a dead link that does nothing when clicked and raises no error.

### Inserting a chapter

A mirror of "Deleting §K", with three differences:

- **Renumber from large to small** (N→N+1 first, then N-1→N…), reason in the second general rule above.
  Both the JSON and the HTML go in that direction.
- **The new chapter really has to be rendered**: follow the insertion render of SKILL.md sub-step 5.5 item 3,
  taking as `oldText` the first line of **the following chapter's** curtain page, `<div class="curtain" id="cX">`,
  and as `newText` the new "curtain page + `.concept`" pair plus that line brought back verbatim;
  to insert after the last chapter, use the opening line of ⑤ or ⑥ as the anchor instead.
- **The new chapter's figure is drawn only now** (the JSON has only a `sketch`), and once it is drawn, every `figure.num` after it gains the number of new figures;
  `.toc-sub` gains an entry, and ② the knowledge map gains a `.n-focus` node and at least one `.edge`.

### Reordering

Moving a chapter somewhere else (or swapping two):

1. **JSON**: move the item within `chapters[]`, then **renumber the whole run** of `number` and `id`
   — every chapter number the move crossed has changed, not just the one that moved. When that is done you still have to work through
   items 3–5, 9 and 10 of the "Deleting §K" JSON side (cross-references, knowledge map, glossary `where`, sentences naming a chapter in the summary, the three self-check groups).
   Figure numbers are renumbered in the new order (J-B 10).
2. **HTML**: **cut that "curtain page + `.concept`" pair across verbatim** — `read` that stretch out first
   (from `<div class="curtain" id="cK">` to its `.concept` `</section>`),
   then one `edit` to delete it at the old position and one `edit` to insert it back at the new one,
   **without retyping one character of the markup in between** (retyping it is another whole-chapter rewrite, exactly what this JSON layer exists to remove).
   Only the `id` and `.curtain-num` follow the new number.
   The rest is the same as items 2–7 of the "Deleting §K" HTML side.
3. **One thing unique to reordering: the dependency margin notes go stale.** In the chapters that were moved,
   sentences in `<aside>` such as "this section assumes you already know §X" and in `.lede` such as "go back to §X first and see…"
   used to refer to something covered **earlier**, and after the move they may point **later**.
   **The `aside` and `lede` of every chapter that was crossed have to be read by a person** — this is item 2 of the 5.2 self-check (order)
   re-run after the fact, and grep cannot find it.

---

## What goes in each of ①–⑩

| | Block | class | The slots inside |
|---|---|---|---|
| ① | header | `.deck-head` | `h1` the topic · `p.meta` the two items at the top (see below) · `p.for-whom` **a starting-point picture from the interview**, not boilerplate. The three lines sit on the dark cover band `div.hero-band`, and the band itself is a child of `<body>`, **kept as a whole verbatim**, with only `data-hero` filled in |
| ② | knowledge map | `.map` | `figure > svg`, **drawn on the spot from `map.sketch`** (the JSON has no markup for this figure). One finished figure is in the section below |
| ③ | primer | `.primer` | `dl > dt/dd`, two or three sentences per entry |
| ④ | concept body | `.concept` | See "④ What one finished chapter looks like" below |
| ⑤ | method comparison | `.compare` | `div.table-wrap > table`: assumptions / where it applies / cost / failure modes |
| ⑥ | summary section | `.summary` | Put the points above back together to answer "so what is this thing actually doing" |
| ⑦ | glossary table | `.glossary` | `dt[id]` + `span.en` the English original (left out entirely when it is the same as the term itself) · `dd` a one-sentence explanation + `span.where` which section it first appears in |
| ⑧ | what to do next | `.next` | `h3` splitting into "Must read / Optional / What to run yourself / The next learning-deck", `li` + `span.why` |
| ⑨ | references | `.refs` | `ol > li[id]`, the title + `a.ref-link`. **Every entry must carry `id="r-…"`**, see "⑨ References and the two-hop citation" below |
| ⑩ | honest boundaries | `.honesty` | `ul > li`, one item at a time, no blanket disclaimer |

### The two items at the top of ① the header

**Estimated reading time** + **date last updated**, written into `p.meta` and separated by `<span class="meta-sep">`:

```html
<p class="meta">
  <span>learning-deck</span>
  <span class="meta-sep" aria-hidden="true"></span>
  <span>about 24 min</span>
  <span class="meta-sep" aria-hidden="true"></span>
  <time datetime="2026-08-21">Last updated 2026-08-21</time>
</p>
```

⚠️ v4 had "three items", the first being the progress bar at the top — **the progress bar was deleted in v5**, and there are now only two.
⚠️ **Compute the reading time when you generate the report and write it in; do not write JS to count it.**
Algorithm: the visible words of the body inside `<body>` ÷ 210 (English technical material runs 180–240 words/min, take the midpoint),
rounded up, plus 0.5 minutes per figure; excluding ⑨ the references and the labels inside SVGs.
If it comes out below 5, write "about 5 min".
⚠️ The date is the date of generation, `datetime` takes the ISO form, and it agrees with the one in the text.

### The three node colors of ② the knowledge map

| class | Meaning | Links to |
|---|---|---|
| `.n-known` | marked "familiar" in the interview | that entry in the glossary, `#g-xxx` |
| `.n-focus` | to be covered, has a body section | `#cN` |
| `.n-brief` | one line only | `#primer` |

An "already known" node **has to be an anchor too** — the reader may not actually remember it, and a link to the glossary is more use than a dead box.

### ② The knowledge map: one finished figure

The template has only a `⟨待填⟩` comment left, so the one below is the only sample. **Change its structure to fit,
do not copy its content** (this is a deck about ECG foundation models, not the one you are writing).

```html
<section class="map" id="map">
  <h2>Knowledge map</h2>
  <p>
    The figure below is this report's skeleton and also its navigation: click any node drawn with a heavy solid outline to jump straight to that section.
    Dashed nodes are covered in two or three sentences in the <a href="#primer">primer</a> only.
  </p>

  <figure>
    <!-- This figure does **not** take role="img": role="img" turns the whole subtree presentational,
         and the in-page anchors inside it disappear for screen readers, while "nodes double as navigation" is exactly what a knowledge map is for.
         Name it with <title> + <desc> and aria-labelledby instead.
         The plain schematics in the body have nothing clickable in them, and role="img" is right for those. -->
    <svg viewBox="0 0 640 340" aria-labelledby="map-svg-title map-svg-desc">
      <title id="map-svg-title">Knowledge map for an ECG foundation model</title>
      <desc id="map-svg-desc">A three-layer dependency graph. The top layer is predicting myocardial infarction with a foundation model; the second layer is task definition, per-lead normalization and fine-tuning strategy; the third layer is leads and sampling rate, contrastive pre-training and evaluation metrics. The heavy nodes are the concepts this report fills in, and every node is a clickable in-page link.</desc>

      <!-- Edges: target → second layer -->
      <path class="edge" d="M300 82 C 200 100, 130 110, 105 138"/>
      <path class="edge" d="M320 82 L 320 138"/>
      <path class="edge" d="M340 82 C 440 100, 510 110, 535 138"/>

      <!-- Edges: second layer → third layer -->
      <path class="edge" d="M105 186 L 105 238"/>
      <path class="edge" d="M320 186 L 320 238"/>
      <path class="edge" d="M535 186 L 535 238"/>

      <!-- Top layer: the target concept -->
      <g class="node n-focus">
        <a href="#summary">
          <rect x="240" y="42" width="160" height="40" rx="5"/>
          <text x="320" y="69" text-anchor="middle" font-size="17">Predict MI</text>
        </a>
      </g>
      <text class="svg-label-faint" x="320" y="26" text-anchor="middle" font-size="13">Target</text>

      <!-- Second layer -->
      <g class="node n-focus">
        <a href="#c1">
          <rect x="20" y="140" width="170" height="46" rx="5"/>
          <text x="105" y="159" text-anchor="middle" font-size="15">Task definition</text>
          <text class="svg-label-faint" x="105" y="179" text-anchor="middle" font-size="12">to cover · §1</text>
        </a>
      </g>
      <g class="node n-focus">
        <a href="#c2">
          <rect x="235" y="140" width="170" height="46" rx="5"/>
          <text x="320" y="159" text-anchor="middle" font-size="15">Per-lead scaling</text>
          <text class="svg-label-faint" x="320" y="179" text-anchor="middle" font-size="12">to cover · §2</text>
        </a>
      </g>
      <g class="node n-brief">
        <a href="#primer">
          <rect x="450" y="140" width="170" height="46" rx="5"/>
          <text x="535" y="170" text-anchor="middle" font-size="15">Fine-tuning</text>
        </a>
      </g>

      <!-- Third layer. An "already known" node is an anchor too: the reader may not actually remember it,
           and a link to the glossary is more use than a dead box. -->
      <g class="node n-known">
        <a href="#g-lead">
          <rect x="20" y="240" width="170" height="46" rx="5"/>
          <text x="105" y="270" text-anchor="middle" font-size="15">12 leads and rate</text>
        </a>
      </g>
      <g class="node n-known">
        <a href="#g-contrastive">
          <rect x="235" y="240" width="170" height="46" rx="5"/>
          <text x="320" y="270" text-anchor="middle" font-size="15">Contrastive pre-train</text>
        </a>
      </g>
      <g class="node n-brief">
        <a href="#primer">
          <rect x="450" y="240" width="170" height="46" rx="5"/>
          <text x="535" y="270" text-anchor="middle" font-size="15">Evaluation metrics</text>
        </a>
      </g>

      <!-- Legend: the swatches reuse the node classes directly, so the styling cannot drift from the nodes and the print backstop covers them too -->
      <g class="legend" transform="translate(20, 306)">
        <g class="node n-known"><rect x="0" y="0" width="14" height="14" rx="3"/></g>
        <text class="svg-label-faint" x="20" y="12" font-size="13">You know this</text>

        <g class="node n-focus"><rect x="110" y="0" width="14" height="14" rx="3"/></g>
        <text class="svg-label-faint" x="130" y="12" font-size="13">To cover</text>

        <g class="node n-brief"><rect x="220" y="0" width="14" height="14" rx="3"/></g>
        <text class="svg-label-faint" x="240" y="12" font-size="13">One line only</text>
      </g>
    </svg>
    <figcaption>
      <b>Fig. 1</b> This report's dependency graph. The two solid green boxes in the third layer are what you marked "familiar" in the interview,
      and this report does not cover them; the heavy red boxes are what is being filled in this time.
    </figcaption>
  </figure>
</section>
```

---

## ④ The concept body

⚠️ **The template carries no example chapters (v5, the user's call).** v4's template came with the shells of two example chapters,
and the render instruction was "chapters 1 and 2 consume those two shells, chapter 3 onward uses insertion". The two paths cost far too differently:
insertion has a one-line comment as `oldText`, while replacing a shell has eighty lines of example SVG in its `oldText`. The result on the fourth real run
was that all nine chapters took the cheap insertion path and the two shells stayed where they were — 9 chapters in the JSON, and in the HTML
11 curtain pages. **There is no shell to use now, and insertion is the only path.**

How to insert: between ③ the primer and ⑤ the method comparison the template has one line reading

```html
<!-- ④-ANCHOR insert concept chapters before this line ⟨待填⟩ -->
```

**One `edit` per chapter**, with that line as `oldText` and `newText` = this chapter's "curtain page + `.concept`"
pair + the same line. **When you insert the last chapter, do not bring that comment back** — it carries `⟨待填⟩`,
and leaving it in gets caught by pre-delivery self-check H1.

### The fixed order within a section (do not improvise)

⚠️ **This order is not yours to keep, it is rendered.** `.lede` / `.aside` / `.boundary` /
`.source` / `.checkout` / `.back` are fixed chapter slots in the `.learning-deck` JSON,
and their positions are pinned by the rendering map in `references/deck-json.md`; the only freely ordered part is the one
in the middle, `blocks` (the five kinds `prose` / `figure` / `eq` / `example` / `pointer`).

```
<section class="concept">
  <p class="lede">the one-line definition</p>            ← word for word the same as on the curtain page
  <aside class="aside reveal">dependency note, "this section assumes you already know §X"</aside>
  <h3>What problem it solves</h3>  <p>…</p>
  <div class="with-figure">
    <h3>Mechanism</h3> <p>…</p>
    <figure><svg …></svg><figcaption><b>Fig. N</b> …</figcaption></figure>
  </div>
  <div class="example reveal"><span class="tag">For example</span><p>…</p></div>
  <div class="boundary reveal"><h3>Common misconceptions and limits</h3><ul>…</ul></div>
  <div class="source reveal"><h3>Sources</h3><ul>…</ul></div>
  <p class="checkout reveal"><b>After this section you should be able to answer:</b> …</p>
  <p class="back"><a href="#map">↑ Back to the knowledge map</a></p>
</section>
```

- A sense of progress through a long document comes from **the current-item highlight in the contents on the left**; there is no word count and no progress bar.
- `.aside` dependency notes: the ones marked "familiar" in the interview are exactly what fills this.
- `.with-figure`: **the figure and the passage about it must be inside the same `.with-figure`**,
  otherwise the figure drifts onto the next screen and the reader cannot match them up.
- The question in `.checkout` has to be **specific enough to answer**, not "did you understand this section".
- What goes inside `.example` is in `references/writing.md` item 4 — the single easiest place in the report to fudge.
- The `.pointer` card (same structure as `.example`: `span.tag` + a passage + an external link) is only for when **the original figure cannot be fetched,
  or the current model cannot see images**, and it points at that figure in the original. **It is not an `.example`**, and it cannot be used to satisfy
  the "at least one example per section" gate — usage is in `references/figures.md`.

### ④ What one finished chapter looks like

Below is one complete "curtain page + `.concept`" pair, in which four of the five block kinds appear once each.
**Change its structure to fit, do not copy its content.**

```html
<div class="curtain" id="c2">
  <div class="curtain-num">§2</div>
  <h2 class="curtain-title">Normalize per lead or per whole record</h2>
  <p class="curtain-lede">
    The <strong>statistical scope</strong> of normalization decides whether the model sees "this lead's shape relative to itself"
    or "this lead's amplitude relative to the whole trace" — change hospital equipment and the two conclusions part ways.
  </p>
</div>

<section class="concept">
  <p class="lede">
    The <strong>statistical scope</strong> of normalization decides whether the model sees "this lead's shape relative to itself"
    or "this lead's amplitude relative to the whole trace" — change hospital equipment and the two conclusions part ways.
  </p>

  <aside class="aside reveal">
    <p>This section assumes you already know the physical meaning of each of the <a class="term" href="#g-lead">12 leads</a>
    — in the interview you marked this one "familiar".</p>
    <p>If you get stuck on "why it collapses across centres", go back to <a href="#c1">§1</a> first and see how the task is defined.</p>
  </aside>

  <h3>What problem it solves</h3>
  <p>
    The absolute amplitude of a raw ECG is affected by three things — electrode placement, skin impedance and device gain —
    and the same patient recorded on two machines can differ by a factor of two in voltage. Without normalization, most of what the model learns is a device fingerprint.
  </p>

  <div class="with-figure">
    <h3>Mechanism</h3>
    <p>
      The three statistical scopes compute completely different things: one mean and variance for the whole record, one per lead,
      one per lead per window. The figure below draws the results for the same stretch of signal under all three scopes side by side.
    </p>

    <figure>
      <svg viewBox="0 0 640 190" role="img"
           aria-label="A comparison of three normalization scopes: whole record, per lead, and per lead per window, each computing a different mean and variance">
        <title>The three normalization scopes</title>

        <!-- Every <svg> carries its own defs and uses its own id prefix.
             Do not reference another figure's marker / pattern across svgs — browsers mostly accept it,
             but it fails silently the moment one of those figures is deleted. -->
        <defs>
          <marker id="ld-arrow-n" viewBox="0 0 10 10" refX="8" refY="5"
                  markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path class="arrow-head" d="M0,0 L10,5 L0,10 z"/>
          </marker>
        </defs>

        <text class="svg-label-faint" x="12" y="20" font-size="13">One stretch of 12-lead signal</text>

        <g>
          <rect x="12" y="32" width="150" height="52" rx="4" class="svg-frame"/>
          <text class="svg-label" x="87" y="52" text-anchor="middle" font-size="14">Whole record</text>
          <text class="svg-label-faint" x="87" y="72" text-anchor="middle" font-size="12">1 pair of μ, σ</text>
        </g>

        <!-- The emphasis spot takes .svg-hi: the middle tier is what matters most on this figure -->
        <g>
          <rect x="245" y="32" width="150" height="52" rx="4" class="svg-hi"/>
          <text class="svg-label" x="320" y="52" text-anchor="middle" font-size="14">Per lead</text>
          <text class="svg-label-faint" x="320" y="72" text-anchor="middle" font-size="12">12 pairs of μ, σ</text>
        </g>

        <g>
          <rect x="478" y="32" width="150" height="52" rx="4" class="svg-frame"/>
          <text class="svg-label" x="553" y="52" text-anchor="middle" font-size="14">Per lead per window</text>
          <text class="svg-label-faint" x="553" y="72" text-anchor="middle" font-size="12">12 × W pairs of μ, σ</text>
        </g>

        <path class="arrow-line draw" d="M162 58 L 239 58" marker-end="url(#ld-arrow-n)"/>
        <path class="arrow-line draw" d="M395 58 L 472 58" marker-end="url(#ld-arrow-n)"/>
        <text class="svg-label-faint" x="320" y="112" text-anchor="middle" font-size="13">
          The narrower the scope, the more cleanly cross-device amplitude differences are wiped out
        </text>
        <text class="svg-label-faint" x="320" y="134" text-anchor="middle" font-size="13">
          — and wiped out with them are the real amplitude relations between leads
        </text>
        <path class="svg-rule" d="M12 156 H628"/>
        <text class="svg-label" x="12" y="178" font-size="14">Left end keeps the most information · right end is the most drift-tolerant</text>
      </svg>
      <figcaption>
        <b>Fig. 3</b> The three statistical scopes compared. The red box is the default choice in a cross-centre setting:
        it absorbs the device-gain difference without flattening the absolute ST elevation the way per-window would.
        <br>This diagram was drawn for this report and does not correspond to any figure in the original.
      </figcaption>
    </figure>
  </div>

  <!-- Equations: Chromium's native MathML. **Do not pull in KaTeX / MathJax**, the CSP will block them.
       The structure is fixed at three levels: .eq > .eq-body > math[display=block], with the number in .eq-num. -->
  <div class="eq">
    <div class="eq-body">
      <math display="block">
        <mrow>
          <msubsup><mi>x</mi><mrow><mi>l</mi><mo>,</mo><mi>t</mi></mrow><mo>&#x2032;</mo></msubsup>
          <mo>=</mo>
          <mfrac>
            <mrow>
              <msub><mi>x</mi><mrow><mi>l</mi><mo>,</mo><mi>t</mi></mrow></msub>
              <mo>&#x2212;</mo>
              <msub><mi>μ</mi><mi>l</mi></msub>
            </mrow>
            <msub><mi>σ</mi><mi>l</mi></msub>
          </mfrac>
        </mrow>
      </math>
    </div>
    <span class="eq-num">(1)</span>
  </div>

  <div class="example reveal">
    <span class="tag">For example</span>
    <p>
      The same patient is recorded on two machines in turn: the R-wave peak in lead V4 is 1.8 mV on machine A
      and 3.1 mV on machine B. After whole-record normalization the two V4 traces still differ by 0.4 standard deviations;
      after per-lead normalization they differ by 0.05. Train the model on machine A's data and test on machine B's, and
      the former drops from AUROC 0.91 to 0.74, the latter to 0.88.
    </p>
  </div>

  <div class="boundary reveal">
    <h3>Common misconceptions and limits</h3>
    <ul>
      <li>
        <strong>"Per-lead normalization is always better"</strong> — it is not. Low voltage as a diagnosis depends on absolute amplitude itself,
        and per-lead normalization wipes it out. To detect low voltage you have to keep amplitude as a separate feature.
      </li>
      <li>
        <strong>"The statistics can be computed once globally on the training set"</strong> — that is a form of data leakage:
        at inference you do not have the test set's distribution. μ and σ must be computed **within each record**.
      </li>
    </ul>
  </div>

  <!-- Sources: **two hops**. What is linked here is the id of that <li> in ⑨ the references, not the paper's URL. -->
  <div class="source reveal">
    <h3>Sources</h3>
    <ul>
      <li>
        The controlled experiment on per-lead normalization across centres is in
        §4 of <a href="#r-strodthoff2021">Strodthoff et al. (2021)</a>.
      </li>
    </ul>
  </div>

  <p class="checkout reveal">
    <b>After this section you should be able to answer:</b> what does each of the three statistical scopes compute?
    Why does cross-centre data have to go per lead? When is per lead the wrong choice instead?
  </p>
  <p class="back"><a href="#map">↑ Back to the knowledge map</a></p>
</section>
```

### The two inline ones

- `.term`: at a term's **first appearance**, bold it and link it to ⑦ the glossary (`<a class="term" href="#g-xxx">`).
  Later mentions are neither bolded nor linked.
- `.formula` / `<code>`: an inline formula or code fragment in a monospace font.

---

## ⑨ References and the two-hop citation

**Citations in the body no longer link straight out to the paper.** They became two hops:

```
in the body, .source has <a href="#r-xxx">Strodthoff et al. (2021)</a>
   ↓ hop one: in-page, landing on that <li id="r-xxx"> in ⑨
<li id="r-xxx"> the full record <a class="ref-link" href="https://…">DOI</a>
   ↓ hop two: external, handed to the system browser
```

Why: in v4 one click in the body jumped out of the app, and the reader could neither see this work's full record (who wrote it,
what year, where it appeared) nor get back to where they were reading. Keeping the first hop in the page separates "let me see what this is"
from "right, now I want to go read the original", which are two different actions.

```html
<section class="refs" id="refs">
  <h2>References</h2>
  <ol>
    <li id="r-strodthoff2021">
      Strodthoff, N. et al. (2021). <i>Deep Learning for ECG Analysis.</i>
      IEEE JBHI 25(5), 1519–1528.
      <br><a class="ref-link" href="https://doi.org/10.1109/JBHI.2020.3022989" target="_blank" rel="noopener">https://doi.org/10.1109/JBHI.2020.3022989</a>
    </li>
  </ol>
</section>
```

⚠️ **Every `<li>` must carry an `id="r-…"`**, and one missing is one dead link that does nothing when clicked (H4 catches it).
Use "first author's surname + year" in lowercase for the id (`r-ho2020` / `r-thygesen2018`), and add a suffix on collision.
⚠️ In-page anchors only work because the viewer injects `<base href="about:srcdoc">` — **do not write your own
`<base>` into the report**, since the viewer only injects its own when the report has none.
⚠️ Only that external link `a.ref-link` takes `target="_blank" rel="noopener"`; the `#r-…` in the body
is an in-page anchor and **must not** take those two attributes (with them it opens an about:srcdoc in a new tab).
⚠️ DOI first. Conference papers in computing (NeurIPS / ICML / ICLR and the like) often have no DOI assigned at all,
and only in that case do you fall back to an arXiv id. **Not one may be invented**, and every one has to be verified back at source with `fastpaper get`.

---

## Equations: native MathML

**Do not pull in KaTeX / MathJax** — they are external resources, the CSP blocks them outright, and all that is left on the page is a run of raw source.
Chromium supports MathML Core natively, and it has been verified to typeset for real under this sandbox + CSP.

Three ways to write it, chosen by complexity; do not mix them:

| Case | How to write it |
|---|---|
| One symbol / a short piece of notation (`x_t`, `β_t`, `N(0, I)`) | `<span class="formula">x_t</span>` |
| Inline but genuinely stacking sub/superscripts, roots or fractions | inline `<math>…</math>` (no `display`) |
| A key equation on a line of its own | the `.eq` wrapper (structure in the chapter sample above) |

Elements in common use: `<mi>` variable · `<mn>` number · `<mo>` operator · `<msub>` `<msup>` sub/superscript ·
`<msqrt>` root · `<mfrac>` fraction · `<mover accent="true">` overbar (`ᾱ` is written
`<mover accent="true"><mi>α</mi><mo>&#xAF;</mo></mover>`) · `<mrow>` grouping ·
`<mo>&#x2062;</mo>` invisible times (do not use `·` or `*`).

⚠️ **Do not write long derivations.** MathML Core's typesetting quality is below KaTeX's, and Greek letters and mathematical symbols fall back to
system fonts; subscripts, fractions and sums are good enough, but a screen-tall derivation looks rough — in that case say in one sentence what
it is doing, and leave the derivation to the original in ⑨.

⚠️ Do not drop the middle level of `.eq`'s three-level structure (`.eq` > `.eq-body` > `math`): a long formula scrolls
horizontally on its own thanks to that level, and without it the body column bursts.

---

## Drawing SVG

**Figures are drawn at sub-step 5.5 (rendering), not in the JSON.** What the JSON gives is "what to draw" —
the `figure` block's `sketch` (`form` the skeleton / `elements[]` what to draw and the line of text on each /
`emphasis` the single most important spot) and ② the knowledge map's `map.sketch` (which also has `nodes[]` / `edges[]`),
shapes in `references/deck-json.md`. **This section governs "how to draw", that volume governs "what to draw",
and the two do not overlap**: a `sketch` writes no coordinates, colors, classes or viewBox, and the rules below are not overridden by `sketch` either.

The spot that `emphasis` names is, at render time, the element wrapped in `.svg-hi`.

- **`viewBox` is 640 wide, and `font-size` inside a figure may not go below 12.** (v3 raised it from 10 to 12: once the body column
  locked its line width the figures got narrower, and at the two-column/one-column tiers the scale factor is about 0.89, so a size-12 label only just renders at 10.7px.
  The measured range is in the template's "Shared pieces inside SVG" passage.) Copy the numbers in the sample above; do not push them down yourself.
- **Colors always use the template's classes** (`.svg-label` `.svg-label-faint` `.svg-formula`
  `.arrow-line` `.arrow-head` `.svg-box` `.svg-frame` `.svg-hi` `.svg-rule`
  `.svg-fill-moss` `.svg-fill-amber` `.noise-dot`), and **do not write `fill="…"` / `stroke="…"` attributes**.
  The one exception is a reference of the form `fill="url(#…)"` pointing at a `<pattern>` / `<marker>` /
  `<radialGradient>` in the same document.
- **Every `<svg>` carries its own `<defs>` and uses its own id prefix**; do not reference another figure's marker across svgs.
- If you introduce a **fill class** the template does not have, you must register an entry back in the `@media print` block,
  or that figure will have an invisible patch when printed or exported — **completely undetectable on screen**.
  Avoid adding one if you can, and use the ones already there.

---

## Explicitly not doing (written down so it is not taken for an omission)

- **`<details>` collapsible blocks.** Native and needing no JS, but collapsed content disappears from skimming and from ⌘F,
  which is a net loss for self-study. (`.toc`'s collapse does not go through `<details>`, it goes through a button in the script — and if the script fails to run,
  the contents stay expanded and nothing gets folded away.)
- **Self-test cards / inline runnable code / a slides form.** All three are things the user explicitly decided against,
  and they may be split into separate skills in future. **Do not casually add them back.**
- **External math typesetting libraries (KaTeX / MathJax).** See "Equations: native MathML" above.
- **External resources and a second `<script>`.** See SKILL.md's hard constraints.
- **A WebGL background in the body or on the chapter curtain pages.** The cost of GPU animation across the whole document (heat, battery drain,
  running constantly in a long document) buys nothing for reading. **Only ① the header layer is WebGL**,
  and the reason is that it leaves the viewport once you scroll past (the template script stops the rAF with an IntersectionObserver).
  The code for the header block is already written in the template, and **there is nothing for you to do** — do not copy it elsewhere.
- **`<h2>` and `.counter` in the body.** See "The curtain page" above: the title and the number appear once, on the curtain page.
- **The top progress bar.** Deleted in v5, reason in "The four v5 changes" above.
- **The "fast track" section.** Same as above.

> The previous version also listed "fixed floating contents" and "hard-limited body line width" as exclusions here.
> **Both were overturned in v3** (see "Three columns and how they degrade" above); do not delete the contents or unlock the line width per the old version.
> Likewise, "no WebGL" was narrowed in v4 to "none in the body or on the curtain pages" — the header layer is now
> WebGL with an inline shader (zero external libraries, zero external resources); do not delete it per the old wording.

---

## Pre-delivery self-check · HTML layer

**The self-check has two layers.** The structural criteria (block counts, whether every chapter has an example, whether every term made it into the glossary,
numbering notation, where a figure came from) are all verified on the JSON, see "JSON self-check" in `references/deck-json.md` —
the JSON is small enough to read through, and there those criteria are **direct assertions**, not the way two thousand lines of HTML leave you counting classes with `grep`
as a proxy for structure.

**Only the four groups that hold once rendered are kept here**: whether the fill anchors were consumed cleanly, whether the template skeleton was touched,
the form of external links, and whether anchors reach anything. Run them once at sub-step 5.6, **once only**.

**Always use `grep`. KyDog does not bundle ripgrep, so `rg` will return 127 without fail**, three tries included.
Copy the list below, replacing `report.html` with the real file name, and **do not improvise**:

```bash
# H1. Were the fill anchors consumed? — the first must be 0 lines, the other two equal and equal to the JSON's chapter count
grep -n '⟨待填' report.html
#   Every place in the template <body> waiting for you to fill it (including ④'s chapter insertion anchor) carries the fill mark,
#   and at render time that comment is replaced by newText along with the position it marks, so not one should remain at delivery.
#   Every remaining line means "this section was never rendered at all".
#   ⚠️ **The pattern is the prefix `⟨待填`, not `⟨待填⟩`.** The mark comes in two forms: the bare `⟨待填⟩`,
#      and forms carrying explanatory text such as `⟨待填: ISO date⟩`. The whole of ① the header (`data-hero`,
#      `h1`, the reading time, the date, `for-whom`) and the two `h2` of ⑤ and ⑥ use the latter,
#      and an exact match on `⟨待填⟩` reaches none of them — when `data-hero` is left unfilled the JS falls back to gridwave silently
#      and the page still renders, which makes this grep the only place it can be caught.
#   ⚠️ This replaces v4's "grep diffusion|Markov|DDPM|ELBO…". The old one checked
#      **whether the template's own example text had been replaced cleanly**; since v5 the template <body> has not one line of example,
#      so that grep never matches, which makes it a self-check that is permanently green. The failure mode it was really guarding against has not changed —
#      "a section was delivered without ever being rendered" — so the criterion became a direct check of whether that position was filled.
#      (On v4's real run it should have gone red: 11 curtain pages against 9 chapters, 41 pieces of example text. The self-check ran,
#      but nothing was reworked on the strength of it. Noted here: **an H1 hit is a rework signal, not an advisory one.**)

grep -c '<div class="curtain"' report.html      # curtain page count
grep -c '<section class="concept"' report.html  # body section count
#   The two numbers must be **equal**, and **equal to the number of chapters in the JSON**.
#   Unequal = a section was missed, a section was inserted twice, or only half of a pair was inserted.

# H2. The template skeleton is untouched — all three should only match the file header / comments inside <style>
grep -c '^<script>' report.html
#   The only criterion is that this number is exactly 1. The word <script comes with a dozen matches from the template, all inside comments
#   (the hard constraints in the file header, a few inside <style>, one inside the script itself); they are **stating the rule itself**,
#   not violating it. What you are actually looking for is a second <script> tag **at the start of a line**.
grep -n 'src="http\|@import\|url(http\|fonts.googleapis\|cdn\.\|unpkg\|fetch(\|XMLHttpRequest\|WebSocket' report.html
#   The template comes with 4 matches, all in the hard-constraint comments in the file header (constraint 2 itself enumerates CDN / @import /
#   img src="http…" / fetch, and constraint 3 has the phrase about loading it as a resource). None is a violation.
#   Inside <body> it should be 0 lines. An <a href="http…"> pointing at a paper is a link, not a resource, and is legal (this grep
#   does not check href either); anything genuinely appearing in img / link / @import / url() or in the script gets blocked by the CSP and must go.
grep -n 'fill="#\|stroke="#\|color: *#\|background: *#' report.html
#   Inside <body>, only the form var(--x, #xxx) with a fallback is legal.
#   The dozen or so matches landing in the @media print block inside <style> (#fff / #000) are the template's own
#   print backstop, which is supposed to be hard-coded, and you have been told outright "do not change one character of <style>" — skip them.

# H3. Every external link carries target/rel — the two numbers must be equal
grep -o 'href="http' report.html | wc -l
grep -o 'target="_blank" rel="noopener"' report.html | wc -l
#   ⚠️ Citations in the body's .source are **two in-page hops** (href="#r-…"), which are not external links
#      and should not carry target/rel. This grep counts only the ones starting href="http, so it naturally never reaches them.

# H4. In-page anchors that reach nothing — should be 0 lines (it prints the bad anchors directly, no eyeballing two lists)
comm -23 \
  <(grep -o '<a href="#[a-zA-Z0-9_-]*"' report.html | sed 's/.*#//;s/"//' | sort -u) \
  <(grep -o 'id="[a-zA-Z0-9_-]*"' report.html | sed 's/id="//;s/"//' | sort -u)
#   The left side is every in-page anchor (contents entries, knowledge-map nodes, the §N links in the body, term links,
#   and the #r-… citation anchors new in v5), the right side is every id. Every line of output is a dead link that
#   does nothing when clicked — **and raises no error**, which is why this check is mandatory.
#   ⚠️ Since v5 this also guards the two-hop citations: every <a href="#r-xxx"> in the body requires
#      an <li id="r-xxx"> in ⑨ the references. A missing id is the single easiest slip to make.
#   ⚠️ This sed **reads**, it does not modify the report: it trims grep's output down to ids inside a pipe,
#      writing not one byte back to the file. What SKILL.md item 5 forbids is using sed/perl/python to **modify**
#      the report file, which does not conflict with this; just copy it.
```

**An H1 hit, or H4 printing a bad anchor, means the render missed a spot** — go back to sub-step 5.5 and re-render that spot,
**do not patch it on the HTML alone** (see SKILL.md hard constraint 6: the HTML is the artifact, and the source of a change is the JSON).
An H2 hit inside `<body>` comes in two kinds:

- The hit lands inside an `<svg>` (a hard-coded `fill="#…"` / `stroke="#…"`) — that is **the drawing** written wrong,
  so **change it to the template's color class directly on the HTML**, leave the JSON alone, because the JSON never had the drawing in it
  (see the three-way table in SKILL.md hard constraint 6).
- The hit lands in body markup (`<img src="http…">`, `@import`, an inline `color: #…`) —
  that means the `html` in the JSON is itself wrong, so **go back to the JSON**, and paste the same line into the HTML afterwards.
