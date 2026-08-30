# Figures · figures.md

Figures in the report come from three sources, **highest priority first**:

1. **The original figure** — the one the authors drew themselves, the most accurate, but only if the model can see images (see "capability branch" below).
2. **A mechanism SVG you draw yourself** — redrawn after you have understood the original; this is this skill's main form.
   ⚠️ **SVG markup does not go into the JSON.** Sub-step 5.3 only writes "what this figure draws" into the `figure` block's `sketch`,
      the markup itself is written out at sub-step 5.5, when rendering (the shape is in `references/deck-json.md`,
      "`sketch` — what this figure draws"; how to draw it is in `references/layout.md`, "Drawing SVG").
3. **A pointer card** — one `.pointer` block (**not `.example`**, see below), with `.tag` reading "Original figure",
   one sentence on what that figure gives you, plus an external link to the original. Use it when neither of the two above works.

   ```html
   <div class="pointer">
     <span class="tag">Original figure</span>
     <p>Fig. 2 of that paper shows how three encoders share one timeline alignment module.
       <a href="https://doi.org/…" target="_blank" rel="noopener">DOI</a></p>
   </div>
   ```

   ⚠️ **A pointer card must not be written as an `example`.** In the JSON it is its own block type, `pointer`
   (`references/deck-json.md`), and the example gate of `references/writing.md` item 4 counts
   `type === "example"` — while a pointer card is precisely the opposite of a "concrete example": it has no numbers, no input
   and output, no contrast, only a place to go. Mixing them lets a card with a DOI satisfy the gate easily, which means the gate is dead.

**Data figures (scatter plots, heat maps, ROC curves, survival curves, forest plots) are never redrawn**, only 1 or 3 apply.
Redrawing a data figure is fabricating experimental results.

---

## Step one: fetch the figures

```bash
fastpaper figures <id> -d papers/ [--overwrite]
```

The command's shape, the range of identifiers `<id>` accepts (arXiv id / PMC id / DOI; PMID and URL are not supported),
and where `-d` writes are already explained in `src/skills/fastpaper/SKILL.md` — go to its "Commands" code block
and find the `fastpaper figures` line, plus the paragraph in the prose containing "an arXiv source package or a Europe PMC
supplementary package" (search by content, not by line number — that file is synced from upstream by `npm run cli:update`
and gets reordered on every upgrade). None of that is repeated here; this only writes the exit-code branches
specific to learning-deck's workflow.

**Follow the exit-code branches, do not invent your own retry strategy** (the table below was measured against fastpaper 0.6.0):

| Exit code | Meaning | What to do |
|---|---|---|
| `0` | Fetched (or the file already existed and was skipped because there was no `--overwrite`) | Carry on |
| `4` | **The original figures cannot be fetched for this paper**: a PDF-only arXiv submission (no source package), a non-OA PMC record, a DOI that does not resolve to a PMCID, or a package with no image files | **Do not retry**; this paper goes to your own drawing / a pointer card |
| `1` | The source does not support `figures`, or the identifier is of the wrong type (PMID / URL) | **Do not retry the same identifier**. If the cause is that you gave a PMID / URL and you have a DOI or arXiv id on hand, swap to that one and run again; if you do not, give up on this paper |
| `2` | The command is written wrong, or the installed fastpaper does not have the `figures` command yet (see the note below) | Fix the command, or take the fallback in the note |

**Measured samples** (`./vendor/current/fastpaper figures … -d /tmp/x`, fastpaper 0.6.0):

- `12345678` (a PMID) → exit code `1`, stderr `Error: PubMed indexes abstracts, not
  files: 12345678`, plus a hint to look up the PMC ID for the same paper.
- `arxiv 0000.00000` (a nonexistent id) → exit code `4`, stderr `Error: Not found on
  arXiv: 0000.00000`.
- `2405.09567` (a PDF-only submission with no source package) → exit code `4`, stderr `Error: arXiv
  has no source package for 2405.09567 (it was submitted as a PDF), so there
  are no original figure files.`, plus a hint to use `fastpaper download` instead. **This is
  the most common "cannot fetch" reason on the arXiv side** — the error message itself points the way: when you hit it, stop guessing,
  go straight to your own drawing / a pointer card, and if you need the PDF for something else, switch to `fastpaper download`.

**Coverage is about 79%** (measured by the user across 39 real papers, verified against fastpaper 0.6.0 on
2026-08-20), and it only covers arXiv and Europe PMC. No other source has this channel; do not try them.

### Note: `unrecognized subcommand` — this version does not have the command yet

This is not the `2` in the table above (the command itself written wrong); it is **the installed fastpaper being older than this document,
without the `figures` command yet** — most likely on versions before 0.6.0. It also shows up as exit code
`2`, but **`unrecognized subcommand` appears in stderr**:

```
error: unrecognized subcommand 'figures'
tip: a similar subcommand exists: 'sources'
```

- **Do not change the command and retry**, and **do not follow that `tip`** — `sources` is the command that lists available sources,
  it has nothing to do with fetching figures, and trying it only wastes a round.
- Go straight to your own SVG + pointer cards, and state in ⑩ the honest boundaries
  that "the installed fastpaper has no `figures` command, so this report uses no original figures".
- This paper needs no further attempt, and **neither do the rest of the papers in this report** — the version will not change mid-session.

---

## Step two: identify the figures

They land like this, **one subdirectory per identifier, file names kept as they are**:

```
papers/PMC7075534/ocz228f1.jpg   ocz228f1.gif   ocz228f2.jpg …
papers/2408.05178/figs/architecture.pdf   figs/saliency.png …
papers/2511.11035/1.pdf   2.pdf   3.pdf
```

⚠️ **File names do not correspond to figure numbers.** `figures` deliberately does not parse `\includegraphics` or captions —
in practice `3.pdf` under `2511.11035` is actually Figure 1. **A figure number can only be confirmed by looking at the figure**,
never inferred from the file name. Infer it wrong and that "Fig. 3" in your caption is invented.

Open `.pdf` figures with `read_pdf_figure` (`read` only accepts jpg / png / gif / webp / bmp;
handing it a PDF is handing it nothing). It does the whole thing in one call: render to PNG,
show you the image, and return the PNG path:

```
read_pdf_figure  { "path": "<absolute path>/figs/architecture.pdf" }
```

Page 1 and scale 2 by default; a figure PDF is usually one page. If small text in the figure is unreadable, raise `scale` to 3.
**`.eps` is not handled** — skip that one and record it in ⑩ the honest boundaries.

Figures that are already png / jpg / gif / webp do not go through this — open them with `read` directly.
Either way: **look at it yourself** to see what it draws. **The PNG path it returns is the one to use
in `<img src>` later** — no path means you did not see this figure, see the next section.

---

## Step three: the capability branch (the criterion comes from the harness, do not guess)

When `read_pdf_figure` or `read` returns any of these, **you did not see this figure**:

```
[Current model does not support images. Nothing was rendered.]
[Current model does not support images. The image will be omitted from this request.]
[Image could not be attached. No path is returned for this figure.]
```

The first two are the same thing — the current model does not accept image input (the first comes
from `read_pdf_figure`, which skips rendering entirely; the second from `read`). The third means the
image could not be attached, and `read_pdf_figure` will not hand you a PNG path either. All three are
handled the same way:

- **Do not embed original figures.** You cannot tell which file belongs to which section, still less confirm the figure number; embedding is embedding at random.
- Fall back to **pointer cards + your own SVG** (your drawing is based on the prose and the caption text, not on the figure you did not see;
  the JSON still only carries `sketch`, and the figure is drawn at 5.5).
- State in ⑩ the honest boundaries: "the current model does not support image input, so no original figures were embedded".

Only a model that can see images goes on to the section below.

---

## Step four: embedding an original figure (when you can see it)

In the JSON this is written as `{ "type": "figure", "kind": "img", "src": "papers/…", "alt": "…" }`,
and it renders into the shape below. **`kind: "img"` has no `sketch`** — the original is not yours to draw.

**Write a relative path, do not encode base64 yourself.** When the viewer renders the report it reads the file itself and turns it into
a `data:` URI written back into `src` — none of that is your concern:

```html
<figure>
  <img src="papers/2408.05178/figs/architecture.png" alt="Overall model architecture">
  <figcaption><b>Fig. 3</b> Original figure, from McKeen et al. (2024) Fig. 2.
    <a href="https://doi.org/…" target="_blank" rel="noopener">DOI</a></figcaption>
</figure>
```

- **The path is relative to the directory the report file is in** (the report is written in the project root and `papers/` is under the root too,
  so it is usually just `papers/<id>/<file name>`, the same path `fastpaper figures` wrote to).
- **The image must be inside the report's own directory tree** — the viewer only accepts that range, and anything that escapes it (`../`, absolute paths)
  is rejected and degrades to the `alt` text; the page will not break, but it will not show the image either.
- Only the extensions `png` / `jpg` / `jpeg` / `gif` / `webp` are accepted; a `.pdf` is first put through step two's
  `read_pdf_figure`, **reference the PNG path it returns**, and `.eps` is still not handled (skip it, record it in ⑩ the honest boundaries).
- There is no size gate and no cap on how many — the viewer has a backstop of 8MB per image / 24MB per report,
  and normal paper figures come nowhere near those numbers, so there is no need to measure before deciding.

The styles for `figure` / `figcaption` / `figure img` are all in the template already (`figure img` is
`max-width: 100%; height: auto`: too-wide figures shrink back into the text column, and figures narrower than it keep their natural size instead of being stretched blurry).
**Do not put an inline `style` on `<img>`** — the template already handles scaling,
and writing one works against the general rule (see the top of `references/layout.md`).

---

## Attribution discipline

**Original and self-drawn: neither may pass itself off as the other.**

In the JSON this is the `figure` block's `credit` field (`"original"` / `"redrawn"` / `"own"`,
see `references/deck-json.md`), and at render time it becomes the sentence in `figcaption` per the table below.
**`credit` is required**, and JSON self-check item 7 verifies it; the table below is what it renders into.
The caption, the figure number and the source are all the figure's **intent**, so change them back in the JSON; how the lines run is the **drawing**,
which is changed on the HTML (SKILL.md hard constraint 6).

| Where the figure came from | What the caption must say |
|---|---|
| An embedded original figure | "**Original figure**, from ⟨first author⟩ et al. (year) Fig. N" + a DOI / arXiv external link |
| Redrawn after understanding the original | "**Redrawn from** ⟨first author⟩ et al. (year) Fig. N" + a DOI / arXiv external link |
| Drawn from the prose, with no counterpart in the original | "This diagram was drawn for this report and does not correspond to any figure in the original" |
| A pointer card | One sentence on what that figure gives you + an external link; **do not restate the numbers in the figure** (you have not checked them) |

A figure number (Fig. N) **may come only from having looked at that figure yourself and matched it to the caption in the original**.
If it does not match, leave the number out and write "that paper's architecture figure".

⚠️ **The source link inside a caption** (`credit.url`, and the one in a pointer card) **is still a direct external link**,
it did not follow v5's two hops. That is deliberate, not an oversight: the two hops (`references/layout.md`,
"⑨ References and the two-hop citation") solve "one click in the body jumps out of the app and you never see the record";
what the caption line says is **where this figure came from**, and the reader clicks it to go look at the page with the original on it,
so an intermediate stop buys nothing. On top of that, a figure's source is not necessarily a work that made it into ⑨ the references
(a paper you took a single figure from, say), and forcing two hops would push you to stuff in a reference nothing in the body cites.

⑩ the honest boundaries has to list, item by item, which figures are originals, which are redrawn (redrawn from which paper, which figure),
which are entirely your own, and which could not be used because of format (`.eps`) or size.

---

## The process in one line

> `fastpaper figures` → exit-code branch → `.pdf` goes through `read_pdf_figure` (renders to PNG and shows the image in one step) →
> cannot see it, fall back → can see it, write a relative path `<img src="papers/…">` (the viewer inlines it at render time,
> no base64 by hand) → caption states the source and figure number → record it in the honest boundaries.
