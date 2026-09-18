---
name: peer-review-response
description: Review someone else's manuscript as a referee and produce a formal review ready to submit — first map what the manuscript says neutrally, then judge the whole (argument chain, claimed contribution), then raise itemized concerns; every concern carries a location, the problem, why it matters, and how to fix it, and every literature judgment ("this has been done before / a key work is missing / the citation does not support the claim") is written only after being verified against a search or the source. Use this skill when the user says review this manuscript for me, I was invited to referee and need to write the report, give this paper some comments, look at this from a reviewer's perspective, or write a review report. How it differs from /peer-review — this one reviews someone else's manuscript and delivers a formal report for the authors and editor; for the user's own manuscript, to self-review and revise, use /peer-review.
---

# Peer Review (someone else's manuscript)

The input is **someone else's manuscript**, and the output is **a formal review report**. The report goes out under the user's (the referee's) name — every concern must survive the authors checking it, and a single concern that does not check out is enough to discredit the whole review.

The review procedure itself lives in `references/review-kernel.md` (the review kernel), shared with `/peer-review` — each skill carries a byte-for-byte identical copy, pinned by a unit test. A kernel change must be made in both copies; do not weigh edits against the "reviewing others" scenario alone.

## Division of labor with the other skills

| | The question |
|---|---|
| `/peer-review` | how should my own manuscript be revised |
| **`/peer-review-response`** | **does someone else's manuscript hold up, and how to phrase the comments** |
| `/fact-check` | does this one sentence hold |
| `/paper-summary` | how does this paper go into my paper |

When one specific claim in the review is genuinely undecided ("the author says X has been proven" — has it?), that is `/fact-check`'s job; do not settle it in passing inside the review.

## Before starting

1. `date +%F`
2. `ls papers/` — the manuscript and related papers may already be there.
3. **Pick sources, and read the SKILL.md of each search tool you will use** (in `<available_skills>`) — needed for literature coverage and citation spot-checks. Per AGENTS.md's "Looking for Papers", decide where the manuscript's literature sits: for a manuscript in Chinese, or one that studies something in China, fastpaper and slowpaper are often both needed.
4. Get the manuscript. Three forms: a Markdown file in the project, a PDF in `papers/` (read section by section with `fastpaper read`), or text the user pasted.
5. **Full text is a hard requirement.** A review cannot be done from the abstract alone — method details, statistical reporting, and the limitations the authors themselves admit all live in the body. If the full text cannot be obtained, stop and ask the user; do not quietly substitute the abstract.
6. When the user is a formally invited referee, say once: many journals restrict the use of AI in reviewing; KyDog runs locally and the manuscript never leaves this machine, but whether to use it, and whose judgment the review is signed with, is the user's own decision. Once is enough.

## How to run the search commands

Everything in AGENTS.md's "how to use tools" applies. Only one thing belongs on disk: the final review report (plus the PDFs `fastpaper download` puts into `papers/` itself). No directories, no scripts, no intermediate files.

Search with the default table format (`-n 8`); `fastpaper get <id>` the ones worth a closer look. When a download fails, read the exit code first: `4` = this source simply does not have it, so switching sources is the only move that means anything; `2` = the command was written wrong; `1` = something else.

---

## The review kernel (Steps 1–3)

**read `references/review-kernel.md` and run it**: neutral mapping → overall judgment → itemized checks; the severity criteria, the five elements of a concern, the numbering rules, and the reference-listing requirement all live there — this file does not repeat them. **Reviewing from memory always degrades.**

**Tell the user what you are doing in a sentence or two at each stage** ("reading the manuscript through first", "now checking its claimed contribution against a search", "going through methods and statistics item by item") — reading and searching go silent for tens of seconds, and without a word the user can only stare at the spinner and guess.

## Writing the report

The template is in `assets/report-template.md`; `write` it to the **project root**:

```
peer-review-response-<manuscript-slug>-YYYY-MM-DD.md
```

The slug is hyphenated English or pinyin. **Quote blocks in the template opening with `[WRITING NOTE]` never enter the report** — not one line; the other `>` quote blocks are part of the report — keep them and fill in the placeholders. **Plain Markdown only, no HTML tags** — KyDog's renderer has no rehype-raw.

**Write the report in the manuscript's language** (an English manuscript gets an English review, section headings translated along with it — the authors must be able to read it directly); talk to the user in the user's language as usual.

When done, give three sentences in the conversation: the overall judgment, the one or two most pressing Majors, the report path. **Remind the user: read it through before submitting — this review is signed with their name.**

## Honest boundaries

- **Judge only what is on the page.** Missing sections still get reviewed, but the report opens by declaring a "partial review" and listing what is absent; **never infer missing content**.
- **Not one literature claim from memory.** "Already done", "missing work", "citation does not support" — all must be confirmed by search or by the source; when nothing is found, write "not found in these sources with these terms".
- **Not a single fabricated id.** Every paper the review cites gets a full reference confirmed at the source — a referee has to produce evidence too.
- **The "limitations of this review" section is mandatory**: what the search covered, which judgments rest on domain knowledge rather than retrieval, whether the figures could be seen. The editor and the authors deserve to know how far this review was verified.
