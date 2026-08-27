---
name: paper-summary
description: Read one or more user-specified papers closely and produce a passage the user can paste straight into their own paper, given in the conversation, never written to a file. **Ask the user first which job this is** — writing it into related work, writing a contrast with it, borrowing or reproducing its method, using its limitations to argue that the user's own work is needed — the same paper calls for completely different text depending on the use. Use this skill when the user says they want a close reading of a paper, asks you to write this one into their related work, asks for the main conclusions of a paper, says they want to cite it but do not know how to phrase it, or asks how several papers should be organized into one passage. It serves the writing stage, and the deliverable is **the passage that goes into the paper**, not a structured summary — fastpaper read already does that.
---

# Close Reading and Writing Material

Serves the **writing stage**. The deliverable is **a passage** — the very one the user is writing, pasted into their paper the moment it is done.

Not a "what is this paper about" summary. `fastpaper read` plus a template already generates that, and it adds nothing.

**Give that passage in the conversation only. Do not write files.** What the user wants is to select and copy. Source-evidence tables, critical analysis, close-reading notes — none of these get output. If something really needs checking, the PDFs are in `papers/`, and going back to the source is more direct than going back to a table of paraphrases.

**Write in the language the user speaks.**

## Division of labor with the other three skills

| | Input | Deliverable |
|---|---|---|
| `/research-ideation` | a research topic | an assessment of whether the topic holds up |
| `/literature-review` | a subject | a field review + a pasteable state-of-the-art section |
| `/research-frontier` | a direction | a decision briefing on the past year's developments |
| **`/paper-summary`** | **the specified papers** | **the passage that pastes into the paper** |

The first three all rely on search to **discover** literature, and all write files. This one does neither — the user supplies the papers, and the deliverable is a passage.

## Before starting

1. `ls papers/` — the paper the user named may already be in there.
2. **Get the paper**: is it a DOI / arXiv id / PMID, or a filename in `papers/`? For an id, run `fastpaper get <id>` first to confirm which paper it is, then `fastpaper download <id> -d papers/`.

## Full text is a hard requirement

**Without the full text this cannot be done.** The abstract has no method details, no experimental conditions, none of the limitations the authors admit — and those are exactly where the writing material comes from.

When a download fails, **read the exit code first**: `4` = this source simply does not have it, so switching sources is the only move that means anything; `2` = the command was written wrong; `1` = something else. For anything other than `4`, go by the judgment given in fastpaper's error.

If the full text is finally out of reach, **stop and ask the user** (`ask_user_question` must be called on its own): you download it into `papers/` by hand and I continue / write the passage from the abstract alone and mark it as such / switch to another paper.

**Do not quietly fall back to the abstract.** A sentence the user takes into their paper that actually comes from the abstract while they believe it comes from the full text is going to cause trouble.

---

## Step 1: Ask which job this is

If the user already said so in the command (`/paper-summary <id> write this into my related work`), just do it, do not ask again. Ask only when they did not say.

`ask_user_question` **must be called on its own**, one question with four options:

| Job | What the resulting text looks like |
|---|---|
| **Write it into related work** | 1–3 sentences forming a passage, academic register, with citations, ready to paste into Related Work / the state-of-the-art section |
| **Write a contrast with it** | Sentences like "Unlike X et al. (year), this work …", landing on the **difference** rather than on restating it |
| **Borrow or reproduce its method** | A method-description passage + the key details needed to reproduce it, **and an explicit note on the ones the paper never states** |
| **Use its limitations to argue necessity** | A transition passage like "Existing work is limited on X … it is therefore necessary to …", used to lead into the user's own work |

The user can write their own answer beyond the options (the tool has a free-text field).

When the job is "write a contrast with it" or "use its limitations to argue necessity", you need to know **what the user's own work is**, or neither the contrast nor the transition can be written. If they have not said, ask in ordinary conversation — this is an open question, and turning it into a multiple-choice one would box them in.

## Step 2: Close reading

**Probe the structure first, do not guess**:

```bash
fastpaper read papers/<file>.pdf --list-sections
```

Request only sections that appeared in the list. `abstract` / `introduction` missing from the list is common — Nature-family journals do not title their abstracts, so in that case reading from the beginning is the way: `fastpaper read <pdf> --max-length 3000`.

Which sections to read depends on the job:

| Job | Read closely |
|---|---|
| Write it into related work | abstract, introduction, conclusion |
| Write a contrast with it | methods, results — the differences live in the details, not in the abstract |
| Borrow or reproduce the method | all of methods, plus the experimental-setup part of results |
| Use limitations to argue necessity | discussion (what the authors admit themselves), results (whether the numbers hold up the conclusions) |

**Use `--grep` to find a specific statement, do not dump the whole text and sift through it yourself**:

```bash
fastpaper read papers/<file>.pdf --grep "limitation" --context 500 --max-matches 10
```

Regex, case-insensitive by default (`(?-i)` for case-sensitive). Use it to find the limitations the authors admit, the conditions under which some number was obtained, how the paper describes its baselines.

### Read critically — this decides how the passage is worded

The critical analysis is not output, but while reading you must watch for the following, **because they directly change which word you should use**:

| What to watch for | How it changes the wording |
|---|---|
| Gap between claim and evidence | An AUC difference of 0.015 is "slightly higher than", not "higher than"; an edge only in the point estimate with overlapping confidence intervals is not "outperforms" |
| Whether the metric matches the task | AUC 0.953 but 67.7% sensitivity at a fixed threshold — that sentence cannot report the AUC alone |
| Whether the baseline is fair | When the comparison conditions differ, carry the condition in the sentence ("on the same test set") |
| Data splits and external validation | With an internal split only, do not write "generalizes to", write "within this cohort" |
| Limitations the authors admit themselves | Carry the hedges that belong there, do not state flatly what the authors themselves would not state flatly |

**Better understated than overstated.** This passage will appear in the user's paper under their name; overstating costs reviewer comments, understating costs nothing.

## Step 3: Write the passage

**There is one criterion and only one: can the user copy the whole passage into their paper without changing a word.**

- **Academic register, in the user's language**, with inline citations as 「作者 等（年份）」 or (Author et al., year)
- **No meta-information of any kind**: no "this paper argues", "the paper points out", "according to the original text" reporting frames
- **No page numbers, no markers** (such as `[abstract only]`) — those get pasted into the paper along with the text
- **Reproduce titles in full**, no truncating with an ellipsis
- **With multiple papers, weave them into one passage**, not one sentence per paper in a row. In real writing multiple papers are written as a single passage anyway: find the shared premise or the shared gap and thread them on one line

**Every specific statement must be verified in the source text.** Anything you cannot verify comes out of the passage — the user will put it into their own paper verbatim under their own name, and one unverified sentence is an academic incident. This step does not appear in the deliverable, but it must be done.

Read it back once you are done: if this passage appeared in a paper as is, could a reader tell it was stitched together? If so, rewrite it.

## Output

**In the conversation, give the passage and nothing else, nothing before or after it.** The user is going to select and copy, and anything around it gets selected too.

**Do not write things like "Verification status: everything verified against the full text".** Everything verifying is what is supposed to happen; saying so carries no information and is only noise. **Silence means normal.**

There is exactly one case that calls for speaking up: **a statement does not come from the full text** (backed by the abstract only, or somewhere you could not verify). Then you must state separately, after the passage, which ones those are — this is a safety floor and cannot be skipped.

Do not recount which sections you read, do not list source evidence, do not write files.

## Honesty boundaries

- **Every sentence in that passage must be verified against the source text.** This is the one place with no slack — the deliverable goes into the user's paper as is.
- **If the full text is out of reach, say it is out of reach**, do not substitute the abstract.
- **Do not search.** Background, or who later overturned this paper, is the job of `/literature-review` and `/research-frontier`.
