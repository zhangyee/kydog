---
name: peer-review
description: Run the user's own manuscript through peer review before submission, then walk through how to revise item by item — without reviewer comments, simulate a review under the review kernel, big picture first (argument chain, contribution), direction before details when something fatal turns up; with real reviewer comments (a decision letter), go straight to triage — must-fix, infeasible, worth pushback — confirm dispositions with the user, then give a concrete fix for each. Use this skill when the user says self-review my manuscript, check it over before I submit, play reviewer and find the problems, or I got the reviewer comments back — how do I revise. How it differs from /peer-review-response — this one is for the user's own manuscript, delivering a revision plan; to review someone else's manuscript and write a formal report, use /peer-review-response.
---

# Peer Review (the user's own manuscript)

The input is **the user's own manuscript** (real reviewer comments may come with it), and the deliverable is **a revision plan**: a severity, a disposition, and a concrete fix for every comment.

The review is only the means; what this skill delivers is "how to revise".

## Division of labor with the other skills

| | The question |
|---|---|
| **`/peer-review`** | **how should my own manuscript be revised** |
| `/peer-review-response` | does someone else's manuscript hold up, and how to phrase the comments |
| `/fact-check` | does this one sentence hold |
| `/paper-summary` | how does this paper go into my paper |

A **factual dispute** inside one reviewer comment ("the reviewer says this was proven wrong") goes to `/fact-check` first — its bounded verdict is exactly the evidence a pushback or a concession needs.

## Two entry points

| What the user provided | Where to start |
|---|---|
| The manuscript only | Step 1: simulated review |
| The manuscript + real reviewer comments (decision letter, itemized comments) | Skip the simulation; go straight to Step 3, triage |

When it is unclear which, ask — an open question, in plain conversation.

## Before starting

1. `date +%F`; `ls papers/`.
2. **read this skill's own `references/review-kernel.md`**. The review kernel — neutral mapping, overall judgment, itemized passes, severity criteria, the five elements of a concern, the numbering rules — all lives there; this file does not repeat it. **Reviewing from memory always degrades** — this is a hard rule. (The kernel is shared with `/peer-review-response`: two byte-for-byte identical copies, pinned by a unit test; change both together.)
3. When literature needs verifying or a missing-work search, **pick sources**: per AGENTS.md's "Looking for Papers", decide where the manuscript's literature sits and read the SKILL.md of each search tool you will use (in `<available_skills>`). For a manuscript in Chinese, or one that studies something in China, fastpaper and slowpaper are often both needed.
4. **Session isolation**: if the current session just took part in writing this manuscript, first tell the user to **start a fresh session** for the review — a context that just wrote the text cannot find its own faults. A fresh session is itself a clean reviewing environment; no further ritual is needed.

The disk discipline is the same as `/peer-review-response`: write only the final report — no directories, no scripts, no intermediate files.

**Tell the user what you are doing in a sentence or two at each stage** ("reading the manuscript through first", "checking its claimed contribution against a search", "triage done — writing the fixes item by item") — reading and searching go silent for tens of seconds, and without a word the user can only stare at the spinner and guess.

---

## Step 1: Simulated review (manuscript only)

Run the kernel in full: neutral mapping → overall judgment → itemized checks. The product has the same structure but a different purpose — this is not a report for an editor, it is a case file for the author; the wording need not be polite, but it must be equally precise and equally source-verified.

## Step 2: Direction first

When the kernel's overall judgment (argument chain, claimed contribution, structure) finds something fatal, **stop and talk direction with the user first** — an open question, in plain conversation; do not turn it into multiple choice with ask_user_question.

Why stop here: with the direction wrong, every itemized comment is polishing inside the wrong frame; once the direction shifts, the comments hanging off the old direction are **voided as a batch**, and making the user confirm them one by one would be pure waste.

Write the outcome of that conversation (direction stands / narrow it / adjust the claim) into the report's first section. With nothing fatal, no conversation is needed — state the judgment and move on.

## Step 3: Triage

For every comment (simulated or real), settle two things: **severity** (by the kernel's criteria) and a **disposition**:

| Disposition | Criterion |
|---|---|
| Revise | the comment holds and the fix is doable |
| Defer | the comment holds but cannot be fixed now — **name what it is stuck on** (missing data, an experiment to add) |
| Reject | the comment does not hold — **give a verifiable reason**: a search-confirmed paper, verbatim text from the manuscript. "I think it's close enough" is not a reason |

Real comments have three further situations to mark: **reviewers contradicting each other** (paste both side by side; the disposition says whom to follow and why); **editor-highlighted or raised by 2+ reviewers** (highest priority; must be addressed head-on); **a reviewer misread** (the manuscript does have it — treat it as "unclear presentation" and fix the presentation; do not push back).

Numbering: simulated comments get **one global sequence** (Majors from 1, Minors continuing the count; severity is never encoded in the number — cite as "comment N"); real comments **keep the decision letter's own IDs** (R1.1, R2.3, editor comments E.1), and the report cites those IDs throughout so the reviewers can follow along.

### Who decides

- **Real reviewer comments: every disposition must be confirmed by the user.** This is the author's authority — which comment cannot be done, which deserves pushback, whom to follow in a conflict; deciding any of them for the user is overreach. Use `ask_user_question` (must be called on its own, at most 4 questions per call, header 12 characters or fewer): one question per comment, options as candidate dispositions (mark your suggestion recommended; the user can write their own). Ask the Majors and the contested ones first; purely clerical Minors (typos, citation formatting) are not worth asking — suggest a disposition directly.
- **Simulated comments: ask only where the disposition depends on the author.** The comments came out of this very review; confirming each one is theater. What genuinely needs asking is only "the disposition turns on something only the author knows" — can data be added, is the user willing to cut a block. Everything else gets its disposition marked "suggested".

## Step 4: Fixes, item by item

Each comment gets one block in the report's "Review comments" section, carrying everything: severity, disposition (with its reason), and the fix. **Not one may silently vanish** — the rejected and the voided keep their blocks with the reason written in; they are the reconciliation baseline for the next round.

Comments dispositioned "revise" get three things:

- **Location**: section name + "verbatim current text"
- **Change to**: text ready to paste into the manuscript, or an operation concrete enough to execute ("delete the third paragraph of 4.2; merge its conclusion into 4.3")
- **Reason**: one sentence

Fixes must be honest: when the experiment cannot be added, soften the claim and concede the limitation — **never package "cannot be done" as "done"**; that moves the landmine from the review stage to after publication. **In R2 and later of a real revision**, fixes cover only what remains — **no new analyses, citations, or arguments the reviewers did not ask for**; adding extras in revision is the number-one cause of rejection in round two.

## The next round

After revising, run this skill again and hand it the previous report along with the manuscript: **the new round reconciles the previous report first** — check item by item whether what was marked "revise" was revised, and revised correctly — and only then looks for new faults. The loop is driven by the user; this skill runs one round at a time.

## Writing the report

The template is in `assets/report-template.md`; `write` it to the **project root**:

```
peer-review-<manuscript-slug>-YYYY-MM-DD.md
```

The slug is hyphenated English or pinyin. Quote blocks opening with `[WRITING NOTE]` stay out of the report as whole blocks; the other `>` quote blocks are kept and filled in. **Plain Markdown, no HTML tags** — KyDog's renderer has no rehype-raw.

Language splits two ways: the report's narration in **the user's language**; the finished text under "change to" in **the manuscript's language** (it must paste straight into the manuscript).

When done, give three sentences in the conversation: the overall judgment, the two or three most pressing items, the report path.

## Honest boundaries

- **A simulated review finding nothing ≠ a manuscript with nothing wrong.** Say in the report that this was one round of model review, no substitute for human referees.
- **Not one disposition of a real comment may be decided for the user.**
- Literature and factual claims follow the same discipline as `/peer-review-response`: verify at the source, fabricate no ids, and when nothing is found write "not found in these sources with these terms".
- **Never oversell a fix** — sentences like "with this revision, acceptance is assured" must never appear.
