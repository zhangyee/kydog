# Intermediate representation · deck-json.md

The report is made in two passes: **write the content into a JSON first, and only render it into HTML once the content is fixed**.
This volume defines what that JSON looks like, what each block renders into, and the pre-delivery self-check at the JSON layer.

The file name matches the report's, in the same directory, only with a different suffix and a leading dot:

```
<project root>/learning-deck-ecg-fm-ami-2026-08-21.html
<project root>/.learning-deck-ecg-fm-ami-2026-08-21.json
```

**Keep this JSON after delivery, do not delete it.** It is not an intermediate file: when the template improves later it can be re-rendered from it,
and a user who wants one sentence changed does not have to redo the interview and the searching. KyDog's file tree does not show files beginning with a dot
(filtered by `readDir` in `projectService.ts`, ignored by `ignored` in `fileWatcher.ts`),
so it will not crowd the tree on the left.

---

## Why this extra layer exists

Across three real runs the agent went around `edit` and rewrote the whole HTML three times (once perl, twice python).
The root cause is not that the ban was too soft, it is **having to edit two thousand lines of HTML before the content is settled** —
writing and revising at once, redoing the whole body on every revision, so "assemble it once and write it back" always beats matching `oldText` section by section.

The JSON separates "think the content through" from "turn it into HTML":

- **Content phase** (sub-steps 5.1–5.4): changing a chapter is changing one node, `edit` matches only a few lines,
  and it never touches the CSS, never touches `<head>`, **never touches the SVG**.
- **Render phase** (sub-step 5.5): the content is already fixed, so you paste according to the mapping table below;
  **the only thing you actually make here is the SVG** — the JSON only has "what this figure draws", and the markup is written out at this step.

**SVG does not go into the JSON, and that is deliberate.** What the content phase has to settle is "which step of the mechanism this figure is about and what is on it",
not `<path d="…">`; putting SVG into the JSON would make the single most expensive part of the report get emitted twice
(once escaped into the JSON, once pasted into the HTML), violating the reason this layer exists at exactly the most expensive point.
**Record the cost honestly: this JSON alone cannot re-render the original figure**, and on a re-render the figures have to be drawn again.

### Word for word: the most important rule in this volume

**Each element of those string-array fields in the JSON is one line of the rendered HTML, leading indentation included.
Paste them verbatim at render time, without adding a single space.**

This is not fastidiousness, it is the entire reason "go back and change the JSON" can be cheap. Say you find a passage badly written after rendering:

```
# change it in the JSON (first edit)
oldText:  "    But this chain has one key property: because every step is Gaussian, composing them still leaves a Gaussian,"
newText:  "    This chain has one key property — every step is Gaussian, so composing them is still Gaussian, which means"

# paste the same change into the HTML (second edit, oldText / newText copied word for word from above)
```

**Two `edit` calls, and the second is a copy-paste of the first.** The cost is 1 change becoming 2, not 1 becoming 20
— the latter is what "rewrite the whole thing" costs. Only structural changes **within a chapter** — adding a block, deleting a block, reordering blocks —
require re-rendering that chapter, and even that is a hundred-odd lines, not the whole report.

⚠️ **Deleting a chapter / inserting a chapter / reordering chapters is a different thing; do not price it by the sentence above.** Chapter numbers `§N` run continuously through the report,
`id === "c" + number`, and the table-of-contents entries, the knowledge-map nodes, the in-page anchors, the figure numbers and the glossary's `where`
all move with them. Which parts to change how is in `references/layout.md`,
"Changing the structure afterwards: delete a chapter / insert a chapter / reorder" — step by step. **Now that 5.2 no longer confirms the outline,
this path is the only calibration entry point**, so do not improvise.

⚠️ **This invariant has one exception: figures.** A `sketch` (see the `figure` section below) **is not a line of HTML**,
it is the basis for drawing the SVG, and not one word of it appears in the HTML at render time. Therefore:

- To change **how a figure is drawn** (a line came out crooked, boxes do not fit, the wrong color class) — **change that `<svg>` directly in the HTML**,
  and leave the JSON alone, because the JSON never had the drawing in it.
- To change **what a figure is for** (which step it should show, the caption, the figure number, the credit) — go back to the JSON and change `sketch` /
  `caption` / `num` / `credit`, then **draw the figure again** and paste it back into the HTML.
  There is no copy-paste discount here; see SKILL.md hard constraint 6.

**Fields named `html` / `intro` / `mathml` / `aside` are always string arrays;
the other fields that contain markup (`lede` / `checkout` / `caption` / `text` / `def` / `boundary[]` /
`source[]` / `honesty[]` …) are single-line strings and hold inline markup only.**
(`sketch` is neither: it is an object, and what it holds is plain-language notes, not markup.)

Double quotes inside a field have to be JSON-escaped as `\"`
(`<a href=\"https://doi.org/…\" target=\"_blank\" rel=\"noopener\">Thygesen et al. (2018)</a>`).
There are not many such double quotes in inline body markup, but **do not switch them to single quotes because escaping is tedious** —
pre-delivery self-check commands like `grep -o 'target="_blank" rel="noopener"'` count the double-quoted form.

---

## The top-level shape

```json
{
  "version": 1,
  "slug": "ecg-fm-ami-2026-08-21",
  "title": "Fine-tuning ECG-FM for AMI prediction",
  "date": "2026-08-21",
  "readingMinutes": 24,
  "forWhom": "This report is written for you — … (a starting-point picture from the interview, not boilerplate)",
  "hero": "gridwave",

  "map":   { "intro": ["<p>…</p>"], "num": 1, "caption": "…",
             "sketch": { "form": "…", "nodes": [ { "label": "…", "state": "focus", "href": "#c1" } ],
                         "edges": [ ["…", "…"] ], "emphasis": "…" } },
  "primer": { "intro": ["<p>…</p>"], "items": [ { "term": "variational lower bound (ELBO)", "html": ["  When the log-likelihood is intractable, settle for optimizing a lower bound on it."] } ] },

  "chapters": [ … see below … ],

  "compare": { "title": "How it compares with a few alternatives", "intro": ["<p>…</p>"],
               "head": ["Method", "Core assumption", "Where it applies", "Cost", "Failure mode"],
               "rows": [ ["Diffusion model", "…", "…", "…", "…"] ] },
  "summary": { "title": "So what is it actually doing", "html": ["<p>…</p>", "<p>…</p>"] },
  "glossary": [ { "id": "g-markov", "zh": "Markov chain", "en": "Markov chain",
                  "def": "The next state depends only on the current state, not on any earlier history.", "where": "§1" } ],
  "next": { "mustRead": [ { "text": "Ho et al. (2020), <i>DDPM</i>", "why": "Sections 2–3 of the original are enough." } ],
            "optional": [], "handsOn": [], "nextDeck": [ { "text": "Conditional generation and CFG — the half you actually need." } ] },
  "references": [ { "id": "r-ho2020",
                    "text": "Ho, J., Jain, A. &amp; Abbeel, P. (2020). <i>Denoising Diffusion Probabilistic Models.</i>",
                    "url": "https://arxiv.org/abs/2006.11239", "linkText": "arXiv:2006.11239", "verified": true } ],
  "honesty": [ "…", "…" ]
}
```

### `hero` — which look the header band uses

One of three strings, pasted verbatim at render time into `data-hero` on `.hero-band` in the HTML:

| Value | Look | How |
|---|---|---|
| `gridwave` | Scan lines / signal waveform (a HUD register), with one sweep of light across | WebGL with an inline shader |
| `constellation` | A constellation of knowledge: nodes drifting slowly, links at short range, a few hot nodes with a halo | canvas 2D |
| `holoband` | Holographic dispersion: slow domain-warp flow + a dispersion ring in the accent color | WebGL with an inline shader |

All three are one version that works across all five themes: the band's ground and foreground colors come from theme variables, so the same code looks
clearly different under vellum / porcelain / sepia / lilac / midnight while still holding together in each.

**How this value is decided: look it up from the first two characters of the slug, see SKILL.md sub-step 5.1.**
"Pick one yourself" is not allowed (it amounts to always picking the first), and neither is randomizing at run time —
**reopening the same report has to give the same face**.

**If the user wants a different face, changing this one field is enough**: set `hero` to one of the other two values,
then set `data-hero` on `.hero-band` in the HTML to the same value (one line in each of two places,
no need to re-render the whole report). A typo, some other value, or the attribute missing entirely all fall back to `gridwave`.

⚠️ The two retired values — `contour` and `prism-css` — **are not legal values**, and writing them in falls back to `gridwave`.

- **`map` likewise only says "what to draw", not the SVG.** The ② knowledge map is the largest figure in the report,
  and it too is drawn at 5.5. Its `sketch` has two more fields than a body figure, because its nodes and edges are themselves content:

  ```json
  "map": {
    "intro": ["<p>The figure below puts everything this report covers side by side…</p>"],
    "num": 1,
    "caption": "Dark is the three blocks being filled in this time, light is what you already know, dashed boxes get one line.",
    "sketch": {
      "form": "Three layers top to bottom: data layer → representation layer → task layer, each layer in a row, arrows from the lower layer to the upper one meaning dependency",
      "nodes": [
        { "label": "12-lead ECG and sampling rate", "state": "known", "href": "#g-lead" },
        { "label": "per-lead normalization",        "state": "focus", "href": "#c2" },
        { "label": "contrastive pre-training",      "state": "brief", "href": "#primer" }
      ],
      "edges": [ ["12-lead ECG and sampling rate", "per-lead normalization"], ["per-lead normalization", "contrastive pre-training"] ],
      "emphasis": "The edge from per-lead normalization to contrastive pre-training is the thickest; it is this report's main line"
    }
  }
  ```

  `state` is one of three, matching "The three node colors of ② the knowledge map" in `references/layout.md`:
  `"known"` = `.n-known` (marked "familiar" in the interview, links to the glossary), `"focus"` = `.n-focus` (has a body section, links to `#cN`),
  `"brief"` = `.n-brief` (one line only, links to `#primer`). Both elements of an entry in `edges[]` are written as the `label` verbatim.
  The legend (`g.legend`) is added by the renderer, not written into the JSON.
- **`compare` exists only when the topic is "a method"**, otherwise write `null` (at render time ⑤ is deleted as a whole
  together with its entry in the table of contents).
- **`summary` is v4's `wrapup` renamed in v5** ("wrap-up" was jargon). If you see the old field name,
  do not copy it across; it is only clean once `wrapup` cannot be found in the repository.
- **`references[].id` is a required field new in v5**: citations in `source[]` in the body are now
  `<a href=\"#r-xxx\">…</a>`, an **in-page** anchor pointing at it, and at render time it lands on the
  `<li id=\"r-xxx\">` in ⑨; the `a.ref-link` inside that `<li>` is the paper's own URL.
  The reasoning behind the two hops and how to write them is in `references/layout.md`, "⑨ References and the two-hop citation".
  Use "first author's surname + year" in lowercase for the id, and add a suffix on collision.
- **`references[].verified` is written `true` only when the record really has been verified back at source with `fastpaper get`.**
  An unverified record should not be in this array at all.
- `readingMinutes` is computed here and written in: visible words in the JSON ÷ 210, rounded up, +0.5 per figure;
  **excluding `references` and excluding `sketch`** (`sketch` is a build note for you, and the reader never sees it).
  The algorithm matches the one under "The three items at the top of ① the header" in `references/layout.md`.

## What a chapter looks like

```json
{
  "number": 1,
  "id": "c1",
  "title": "Define the AMI task first",
  "tier": "heard of it, cannot explain",
  "lede": "Defining the AMI task means <strong>nailing down three things: who is being predicted, at which time point, and by what evidence it is adjudicated</strong> — …",
  "aside": ["<p>This section assumes you already know <a class=\"term\" href=\"#g-icd\">discharge diagnosis codes</a>…</p>"],
  "blocks": [ … ],
  "boundary": [
    "<strong>\"The discharge diagnosis code is the label\"</strong> — it is not. … (a concrete situation / concrete numbers / a concrete contrast)"
  ],
  "source": [
    "The fourth universal definition comes from <a href=\"#r-thygesen2018\">Thygesen et al. (2018)</a>."
  ],
  "checkout": "Why does using the discharge diagnosis code as the label push a model's AUROC up and then fail to hold it?"
}
```

⚠️ **`lede` appears here once and only once.** At render time it is pasted into two places (`.curtain-lede` on the curtain page and
`.lede` in the body), which makes "word for word identical in both places" **structurally impossible to break**, so it no longer needs checking afterwards.
`title` and `number` are the same: they appear once, on the curtain page — which is why `blocks` **must not contain an `<h2>`**.

⚠️ **`tier` has only two legal values**: `"heard of it, cannot explain"` / `"never encountered"`.
A concept marked `"familiar"` **does not become a chapter**; it appears only in `map.sketch.nodes[]` as a node with `state: "known"` (see `references/interview.md`).
How the tier changes the way a section is written is in `references/writing.md` item 7.

⚠️ `lede` / `checkout` / `boundary[]` / `source[]` are **single-line strings** holding inline markup only
(`<strong>` `<em>` `<code>` `<span class="formula">` `<a>` `<math>`).
`aside` / `blocks[].html` and the like are **string arrays**, and may hold block-level markup.

---

## `blocks[].type`: five of them, exactly five

`type` is a **closed enumeration**. The five below are every block type that has a real component and real CSS in the template.
Writing a class outside the list raises no error, it just renders as a run of bare text.

| `type` | Renders into | How many per chapter |
|---|---|---|
| `prose` | `<h3>` + some `<p>` | unlimited |
| `figure` | `.with-figure` (`<h3>` + the passage about the figure + `<figure>`) | **at least 1** |
| `eq` | `.eq > .eq-body > <math display="block">` + `.eq-num` | unlimited; only for chapters with many equations |
| `example` | `.example.reveal` (`.tag` + body) | **at least 1** |
| `pointer` | `.pointer` (`.tag` + body + external link) | unlimited, and **does not stand in for `example`** |

`lede` / `aside` / `boundary` / `source` / `checkout` / `.back` **are not in this enumeration** —
they are the chapter's fixed slots (the fields in the chapter shape above), placed by the renderer, not by the order of `blocks`.
That makes "⑤ the fixed order within a section" in `references/layout.md` a rendered outcome rather than a rule anyone has to keep.

### Why there is no `table`

All of the template's table styles hang off `.compare` (`.compare table` / `.compare th` / `.compare td` /
`.compare thead th` / `.compare tbody tr:nth-child(even)`), and **there is no generic `table` rule at all**.
A `<table>` written into `.concept` renders as a bare table with no borders, no zebra striping and no alignment
— no error, just ugly. So a table in the body that can be broken up into `prose` should be; and if it genuinely has to be a table,
that means it is ⑤ the method comparison and belongs in `compare`. **This is not a missing block type, it is deliberately withheld.**

### `prose`

```json
{ "type": "prose", "heading": "What problem it solves",
  "html": ["  <p>Before there is an explicit label, the most common practice is to take the discharge diagnosis code…</p>",
           "  <p>So the model gets AUROC 0.94 on the test set and drops to 0.71 at another hospital.</p>"] }
```

`heading` may be omitted (omit it and no `<h3>` comes out). The first `prose` of a chapter is usually
"what problem it solves", see `references/writing.md` item 2.

### `figure`

```json
{ "type": "figure",
  "heading": "Mechanism",
  "intro": ["  <p>Draw the label definition as a timeline, with the three things taking one stretch each…</p>"],
  "num": 2,
  "kind": "svg",
  "sketch": {
    "form": "One timeline running across with four ticks on it; three boxes above the axis, one input-window band below it",
    "elements": [
      "Four ticks left to right on the timeline: admission 0h · first ECG 0.5h · troponin peak 12h · discharge diagnosis day 5",
      "Three boxes above the axis sitting on the first three ticks, reading 'who is being predicted', 'at which time point', 'by what evidence it is adjudicated'",
      "A narrow band below the axis covering 0h–6h, labelled 'the input window the model can see'",
      "A dashed arrow pulled left from the 'discharge diagnosis' tick into the band, labelled 'label leakage: the adjudicating evidence fell back into the input window'"
    ],
    "emphasis": "The band's right edge stops to the left of the troponin peak — that is the graphical form of 'the adjudicating evidence must not fall into the input window'"
  },
  "caption": "The top row is … the bottom row is …",
  "credit": { "kind": "own" } }
```

- `kind` is `"svg"` or `"img"`. With `"img"`, use `"src"` + `"alt"` in place of `"sketch"`,
  and write `src` as a relative path inside the report's directory tree (`papers/<id>/<file name>`), **do not encode base64 yourself**,
  see `references/figures.md`. An original figure is not yours to draw, so `"img"` has no `sketch`.
- With both `heading` and `intro` omitted it renders as a bare `<figure>`, not wrapped in `.with-figure`.
  **If you have something to say about the figure, do not omit them** — a figure that is not in the same `.with-figure` as the passage about it drifts onto the next screen.
- `num` is the figure number, continuous through the report; **the one in `map` is figure 1**, and chapter figures count on from 2.
- `credit.kind` is one of three; this is the structured form of "Attribution discipline" in `references/figures.md`:

  | `credit.kind` | Also needs | The sentence rendered into `figcaption` |
  |---|---|---|
  | `"original"` | `paper` `fig` `url` | "**Original figure**, from ⟨paper⟩ ⟨fig⟩" + external link |
  | `"redrawn"` | `paper` `fig` `url` | "**Redrawn from** ⟨paper⟩ ⟨fig⟩" + external link |
  | `"own"` | —— | "This diagram was drawn for this report and does not correspond to any figure in the original" |

  A figure number (`fig`) **may come only from having looked at the figure yourself and matched it to the caption in the original**; if it does not match, omit `fig`
  and follow `paper` with "'s architecture figure".

#### `sketch`: what this figure draws

Three fields, all required:

| Field | What to write |
|---|---|
| `form` | One sentence fixing the **skeleton**: a horizontal timeline / a top-down process chain / two facing columns / a layered block diagram / input-transform-output in three stages… and roughly how it is laid out |
| `elements[]` | **What is on the figure**, one item each, ordered left to right and top to bottom. Each item carries **the line of text on it** (the label is the content), and how it relates to the others (which thing the arrow points at, what it is nested inside, what it contrasts with) |
| `emphasis` | **The single most important spot** on this figure, and why it matters. At render time it is the element wrapped in `.svg-hi`; and when 5.4 judges whether the figure is worth drawing, this is the sentence it judges |

**`elements` is normally 4–8 items.** Fewer than 3 means there is nothing much to draw (write that passage straight into `prose`);
more than 10 means the figure is trying to say too much, so split it in two or move the secondary things into the body
(the template's `.draw` stroke animation also caps at 6, see `references/layout.md`).

**Two edges of granularity**, and both go wrong:

- **Too coarse** ("draw a flowchart showing how the data becomes a prediction") — at 5.5 you would still have to work out what to draw,
  which means the figure's content was never settled in the JSON at all, and 5.4 had nothing to judge.
- **Too fine** — a `sketch` **does not write** coordinates, `viewBox`, width or height, colors, class names, font sizes,
  or the `d` of `<defs>` / `marker` / `path`; not a single angle bracket.
  Writing those is retyping the SVG in natural language, hauling back in exactly what was just taken out.
  **The drawing belongs entirely to "Drawing SVG" in `references/layout.md`**, which already fixes the viewBox,
  the minimum font size and the color classes; a `sketch` neither repeats them nor may override them.

The criterion in one line: **`sketch` settles "what to draw", layout.md settles "how to draw it".**

### `eq`

```json
{ "type": "eq", "num": "(1)",
  "mathml": ["      <math display=\"block\">",
             "        <mrow><msub><mi>x</mi><mi>t</mi></msub><mo>=</mo>…</mrow>",
             "      </math>"] }
```

`num` may be omitted. How to write it, the elements in common use, and "do not write long derivations" are in `references/layout.md`, "Equations: native MathML".
For inline notation that is just one symbol, do not open an `eq` block; write `<span class="formula">x_t</span>` in `html` directly.

### `example`

```json
{ "type": "example",
  "html": ["    <p>The same patient arrives at the emergency department with chest pain on 2024-03-11, has a first ECG at 18:42…</p>"] }
```

`.tag` is always "For example", added by the renderer, and not written into the JSON.
What goes inside (concrete numbers / a concrete input and output / a right-versus-wrong contrast) is in `references/writing.md` item 4
— the single easiest place in the report to fudge.

### `pointer`

```json
{ "type": "pointer", "tag": "Original figure",
  "html": ["    <p>Fig. 2 of that paper shows how three encoders share one timeline alignment module.",
           "      <a href=\"https://doi.org/…\" target=\"_blank\" rel=\"noopener\">DOI</a></p>"] }
```

Used when the original figures cannot be fetched, or when the current model cannot see images; it points at that figure in the original.
⚠️ **It does not stand in for `example`.** A pointer card has no numbers, no input and output, no contrast,
and is the opposite of a "concrete example"; the gate in group J-B below counts `type == "example"` and naturally never reaches it.

---

## JSON → HTML rendering map

Sub-step 5.5 pastes according to this table. The left side is the field in the JSON, the right side is the markup in the template.
**Apart from the figures there is no room for invention anywhere in it** — the figures are the one place on this table where you actually create something:
the JSON gives "what to draw" (`sketch`), the SVG markup is written out at this step,
and how to draw it follows "Drawing SVG" in `references/layout.md`; do not invent your own scheme.

| JSON | HTML |
|---|---|
| `hero` | `data-hero` on `div.hero-band` in `<body>` (**the only place**, value pasted verbatim) |
| `title` | `.deck-head > h1` |
| `readingMinutes` / `date` | the "about N min" in `p.meta` and `<time datetime="…">Last updated …</time>` |
| `forWhom` | `p.for-whom` |
| `map.intro` / `map.caption` | the `<p>` / `figcaption` inside `section.map#map` (prefixed `<b>Fig. {num}</b>`) |
| `map.sketch` | the `figure > svg` inside `section.map#map`, **drawn on the spot from `sketch`**: each entry of `nodes[]` is one `g.node`, its class set by `state` (`known`/`focus`/`brief` → `.n-known`/`.n-focus`/`.n-brief`), with `<a href="{href}">` wrapping `rect` + `text` inside the node (`text` holds `label`); each entry of `edges[]` is one `.edge`; `g.legend` is added following the template |
| `primer.items[]` | `section.primer#primer > dl`: `<dt>{term}</dt>` + `<dd>{html}</dd>` |
| `chapters[].number` / `.title` / `.lede` | inside `<div class="curtain" id="{id}">`, the `.curtain-num` (holding `§{number}`) / `.curtain-title` / `.curtain-lede` |
| `chapters[].lede` | the first element of the `<section class="concept">` that follows, `<p class="lede">` (**word for word identical to the one above**) |
| `chapters[].aside` | `<aside class="aside reveal">` |
| `chapters[].blocks[]` | see how each of the five blocks above is written, laid out in array order |
| `figure` block (`kind: "svg"`) | `.with-figure`: `<h3>{heading}</h3>` + `{intro}` + `<figure>` + `<figcaption><b>Fig. {num}</b> {caption} {the credit sentence}</figcaption>`. The `<svg>` in the middle is **drawn on the spot from `sketch`** (`form` fixes the skeleton, `elements[]` fixes what is drawn and the text on each, the `emphasis` spot is wrapped in `.svg-hi`), and not a word of `sketch` itself enters the HTML |
| `figure` block (`kind: "img"`) | as above, except that the `<figure>` holds `<img src="{src}" alt="{alt}">` and there is nothing to draw |
| `chapters[].boundary[]` | `<div class="boundary reveal"><h3>Common misconceptions and limits</h3><ul><li>…</li></ul></div>` |
| `chapters[].source[]` | `<div class="source reveal"><h3>Sources</h3><ul><li>…</li></ul></div>` |
| `chapters[].checkout` | `<p class="checkout reveal"><b>After this section you should be able to answer:</b> {checkout}</p>` |
| (fixed) | `<p class="back"><a href="#map">↑ Back to the knowledge map</a></p>`, at the end of every chapter, not written in the JSON |
| `compare` | `section.compare#compare`: `<h2>{title}</h2>` + `{intro}` + `.table-wrap > table` (`head` goes into `thead th[scope=col]`, `rows[i][0]` into `tbody th[scope=row]`, the rest into `td`) + `p.back` |
| `summary` | `section.summary#summary`: `<h2>{title}</h2>` + `{html}` |
| `glossary[]` | `section.glossary#glossary > dl`: `<dt id="{id}">{zh}<span class="en">{en}</span></dt>` + `<dd>{def}<span class="where">first appears in {where}</span></dd>` |
| `next.*` | `section.next#next`: four `<h3>`s (Must read / Optional / What to run yourself / The next learning-deck) each with a `<ul>`, `<li>{text}<span class="why">{why}</span></li>` (`why` may be omitted) |
| `references[]` | `section.refs#refs > ol > li`: `{text}<br><a class="ref-link" href="{url}" target="_blank" rel="noopener">{linkText}</a>` |
| `honesty[]` | `section.honesty#honesty > ul > li` |
| `.toc` entries | decided by whether `map` / `primer` / `chapters` / `compare` / `summary` / `glossary` / `next` / `references` / `honesty` have content; the concept group writes `§{number} {title}`, and the other entries **write the name only, unnumbered** |

⚠️ Every external link takes `target="_blank" rel="noopener"`;
every color takes the form `var(--x, #xxx)`; both are SKILL.md hard constraints 2–4.

---

## JSON self-check (before delivery, 6 groups)

**Read the whole JSON through and verify item by item.** It is small enough to read through — which is exactly where it beats counting classes in two thousand lines of HTML:
every item below is a **direct assertion**, not text standing in as a proxy for structure.

⚠️ **Do not write a script to check these.** `node` does exist inside Electron, but SKILL.md hard constraint 5
holds absolutely: once you open the door to "a read-only check may use a script", the lesson of the last two times is that it grows into "and so may a modification".
Only a rule with no exceptions holds.

**J-A chapter skeleton**

1. `chapters[i].number === i + 1`, `chapters[i].id === "c" + number`, continuous through the report with no gaps.
2. Every chapter has a non-empty `title` / `lede` / `tier` / `checkout`, and at least 1 item each in `boundary` and `source`;
   `tier` takes one of the two values `"heard of it, cannot explain"` / `"never encountered"`.
3. No `html` / `intro` / `aside` anywhere **contains an `<h2>` or a `class="counter"`**
   — the title and the number appear once, on the curtain page.
4. `TODO` / `to be added` / `placeholder` cannot be found anywhere; no chapter has `blocks` / `boundary` / `source` equal to `[]`.
   (`compare` written as `null` and `next.optional` left empty are legal — that is "this report does not have this item", not "unfinished".)

**J-B the per-chapter gates**

5. **At least 1** block with `type === "example"` in each chapter's `blocks`; `pointer` does not count.
6. **At least 1** block with `type === "figure"` in each chapter's `blocks` (at least one mechanism figure per key concept).
7. Every `figure` has `credit.kind`; `"original"` / `"redrawn"` also need `paper` and `url`.
8. Every `figure` with `kind: "svg"` has a `sketch` whose `form` / `elements` / `emphasis`
   are **all non-empty**, with `elements` **no fewer than 3 items** (a figure with fewer than 3 is not worth drawing; write that passage into `prose`);
   `map.sketch` additionally needs a non-empty `nodes[]` and `edges[]`.
   Those with `kind: "img"` have `src` and `alt`, and **no** `sketch`.
9. **No drawing may appear inside a `sketch`**: nowhere in the whole `sketch` (including `map.sketch`) can you find an angle bracket,
   an attribute or class name like `viewBox` / `fill` / `stroke` / `svg-` / `n-focus`,
   or any coordinate or size number. If there is one, that is the SVG retyped in prose; delete that part
   — the drawing belongs to "Drawing SVG" in `references/layout.md`, and a `sketch` only says what to draw.
10. `num` does not repeat anywhere and counts continuously from 1 (the one in `map`).

**J-C terms and anchors**

11. Every abbreviation appearing in the body (two or more capitals in a row: AMI, ECG, ELBO, CFG…)
    has an entry in `glossary` (matched on `en` or `zh`). **Search for each one; do not go by impression.**
12. Every `href="#g-…"` has its target in `glossary[].id`;
    every `href="#c…"` has its target in `chapters[].id`;
    every `href="#r-…"` has its target in `references[].id` (**new in v5**: body citations are
    two in-page hops, and the first hop points here; `source[]` should no longer contain `href="https://…"`);
    the targets of `map.sketch.nodes[].href` fall within `chapters[].id` / `glossary[].id` / `#primer` / `#summary`,
    and every node has an `href` ("already known" nodes have to be anchors too).
13. `glossary[].where` holds a `§N` or the name of an auxiliary section, and that section really is where the term first appears.

**J-D numbering notation**

14. `§` is used only on concept chapters. Table-of-contents entries pointing at chapters write `§N Title`,
    and those pointing at auxiliary sections such as ③⑤⑥ **carry no `§`**, only the name.
15. Nowhere in the report is there a second notation such as `01` / `Chapter 1` / `item N of M`.

**J-E literature**

16. Every `references[].verified` is `true`; if one is not, delete that entry.
17. Every paper mentioned in `source[]` has a matching `id` in `references`.
    **Neither `source[]` nor the body writes a DOI / arXiv URL directly any more** — those URLs appear only
    on `references[].url`, and the body always goes through `#r-…` (v5's two hops, see
    "⑨ References and the two-hop citation" in `references/layout.md`).
18. Every `references[].id` is unique in the report and starts with `r-`, and each one really is cited by at least one `source[]`
    or by the body — listing a work nothing cites means it did not actually make it into this report.

**J-F tier against depth** (the structured form of `references/writing.md` item 7)

19. In a chapter with `tier === "never encountered"`, the `html` of the first `prose` block is **no fewer than two paragraphs**,
    and the first paragraph contains none of that chapter's core terms.
20. In a chapter with `tier === "heard of it, cannot explain"`, the first `figure` block appears within the first three of `blocks`
    ("reaches the mechanism within three paragraphs").
21. Concepts marked "familiar" **have not** become chapters; they appear only in `map.sketch.nodes[]` as nodes with `state: "known"`.

**J-G the header**

22. `hero` is one of the three values `gridwave` / `constellation` / `holoband`,
    and is **exactly the one looked up from the first two characters of the slug via the two tables in SKILL.md sub-step 5.1** —
    not "the one that looked nice". Writing another value raises no error, it only falls back silently to `gridwave`.

If something fails, go back to sub-step 5.3 and fix that chapter; **the HTML does not exist yet at this point**, so it is only a few lines to change.

The seven writing-quality items (whether the examples carry numbers, whether the limits carry concrete situations, how many imperatives there are,
whether a single paragraph exceeds two new terms) are **read by a person**, see `references/writing.md` item 9,
and are read through together with this step.
