# Interview · interview.md

Three rounds of interview are where this skill's entire value sits. Skip them and the output is generic popular science.

This volume covers two things — **how to design the questions** (shape, count, layering), and **how the answers land in the report**.
What each slot should look like is in `references/writing.md`.

---

## Tool constraints (a violation is refused, not ignored)

The hard caps of `ask_user_question`:

| | Cap | How this skill actually uses it |
|---|---|---|
| Questions per call | **10** | **Use all of them**. Questions cost almost nothing — the UI shows one question per screen and you page through, so more questions only means more pages |
| Options per question | **8** | Concept questions always use **3** (the three tiers of mastery); only the depth question in round 1 uses 3–4 |
| `header` | 12 characters | The short label at the top of a question's screen — write the concept's name |
| `recommended` | at most one per question | Interview questions **must not use it at all** — this asks what they know, it is not for you to recommend an answer |

**`ask_user_question` must be called on its own.** Put it in the same batch of tool calls as another tool and
the whole batch gets blocked, every call receives the same refusal reason, and the round is wasted.
One tool call in the batch, wait for the answer, then send the next batch.

The user can write their own answer outside the options (the tool comes with a free-text box). **Tell them this in ordinary conversation before round 1 starts**,
otherwise they will assume they can only pick from the boxes you gave — the "opening line" section below already writes this in.

---

## Shape — one question per concept, three options for three tiers of mastery

> **One question = one concept. The stem is the concept itself (its name + one line on where it sits in this topic),
> the three options = familiar / heard of it, cannot explain / never encountered, `multiSelect: false` (single choice).**

**The option descriptions must be tailored to this concept; generic boilerplate is not allowed.** This is the most important line in this volume:
the user is already revising while they answer — when they read "per lead or over the whole dataset",
they either remember that they know it, or realize for the first time that the distinction exists, and both are a gain for them.
A question written as "I get it / I sort of get it / I do not get it" leaves them with nothing, and gets you no accurate tier either.

A question that passes looks like this:

```
question:   z-score normalization: subtract the mean, divide by the standard deviation, put everything on one scale
header:     z-score
multiSelect: false
options:
  - label:       Can explain it
    description: Can say whether the statistics are taken per lead, per record or over the whole dataset, and how the three results differ
  - label:       Heard of it, cannot explain
    description: Knows it is "subtract the mean, divide by the standard deviation", but has never thought about what a different statistical scope changes
  - label:       Never encountered
    description: First time seeing it; needs to start from "why normalize at all"
```

The wording of the three `label`s **adapts to the topic** (a math concept gets "can derive it", an experimental method gets "can run it once myself"),
but the tiers themselves are fixed — they are the three tiers of `writing.md` item 7:
**familiar → heard of it, cannot explain → never encountered**, each one shallower than the last. Use those three names when assigning a tier, do not invent a fourth.

**What not to do**: pack a whole cluster of concepts into one question's options and let them multi-select "which ones I know".
That leaves the tier with only two states, ticked / not ticked, and the middle tier — precisely the one that most deserves a section — is dropped outright,
while the option text degenerates into a string of nouns that helps nobody remember anything.

---

## How many questions — this skill is meant to ask a lot

**At most 10 questions per round, at most 30 concepts across three rounds, one concept per question.** Using them all is normal, not over-asking.

- **Round 1**: 1 question on learning depth (see below) + at most 9 concepts.
- **Rounds 2 and 3**: at most 10 concepts each.

The question pool is the 2–3 layer candidate knowledge graph from Step 2. **Stop when you have enough** — if the graph has only 12 nodes, ask 12,
do not invent concepts to fill the cap.

---

## Opening line (before round 1, said in ordinary conversation, not stuffed into a question)

> First, round 1 to set the baseline. I will go through the concepts one by one; for each, pick the tier that matches where you are now.
> Your answers decide which parts of this report get unpacked and which get one line. If none of the three fits, you can write your own answer outside the options.

**Do not make the criterion complicated.** Asking them in one sentence to judge both "can I explain it" and "can I make design decisions from it",
then adding "not picking this does not mean you have never heard of it" — three layers of qualification stacked up and they no longer know what standard to judge by.
The three tiers already express the whole range on their own.

---

## The first question of round 1 — how far they want to get

**This skill produces self-study material, so it asks about learning depth only, never about project planning.**
"Judge whether this line is worth the investment", "goes into the proposal", "clinical deployment assessment" are `/research-ideation` questions;
asking them here goes off topic, and it turns the report into a feasibility argument.

Three fixed options (wording can be tuned to the topic, the tiers do not change):

```
question:   How far do you want to get with this topic?
header:     How far
multiSelect: false
options:
  - label:       Follow what others do
    description: No longer gets stuck on the relevant papers, reports or code; knows what each step does and why it is done that way
  - label:       Can run it myself
    description: Can follow the standard recipe end to end once, and knows which link to go back and check when something goes wrong
  - label:       Can modify it
    description: Can state where the assumptions and costs of the existing approach are, build their own variant from that and say why
```

**Do not set `recommended` on this question** — you do not know how far they want to get.
Its output feeds ① the header line "who this report is written for" and ⑧ what to do next,
and it also decides how deep the mechanism goes: someone who only wants to follow along needs no engineering detail, someone who wants to modify it needs exactly that.

---

## How the three rounds build up

- **Round 1**: the depth question + the top layer and the second layer concepts.
- **Round 2**: drill one layer down, only under the branches marked "heard of it, cannot explain" and "never encountered".
  Branches marked "familiar" are not asked about further and do not enter the body — they appear only in ② the knowledge map as
  "already known" nodes, linked to the glossary.
- **Round 3**: clear out the **prerequisites** of the sections you are going to write.

Concepts even earlier than that, still out of reach after three rounds, **are not chased any further** — they go straight into ③ the primer, two or three sentences each.
Researchers come with uneven foundations, and asking every dependency chain down to its root wastes their patience.

**What the next round asks is decided by the previous round's answers.** Fixing all three rounds up front is the same as not interviewing at all.

---

## Exception branches

- **The user skips a question**: count it as unanswered and handle it as "heard of it, cannot explain" — treating something unverified as "familiar" and dropping it entirely
  is far riskier. And say plainly in ① the starting-point picture in the header that this item went unanswered.
- **The user closed the prompt**: this round stops. Ask them in ordinary conversation whether they would rather talk it through some other way or shelve it,
  do not talk to yourself and answer the remaining two rounds on their behalf.
- **They wrote their own answer outside the options**: that is the single most valuable piece of information; use it verbatim in the starting-point picture,
  do not fold it into one of the boxes you had preset.

---

## The three destinations of the interview results

**Every one of them has to be genuinely used**, otherwise this step was wasted:

| Interview result | Where it lands in the report |
|---|---|
| Learning depth + overall starting point | ① the header line "who this report is written for", and ⑧ what to do next |
| The tier of each concept (**lands in each chapter's `tier` field in the JSON**, see `references/deck-json.md`) | ② the three node colors of the knowledge map (`.n-known` / `.n-focus` / `.n-brief`) + ④ which sections get written and **how deep each one goes** (`writing.md` item 7) + ③ which ones the primer takes in |
| The ones marked "familiar" | ④ the `.aside` dependency margin note in each section, "this section assumes you already know §X" |

(In the JSON these three colors are written as `map.sketch.nodes[].state` values `"known"` / `"focus"` / `"brief"`,
see `references/deck-json.md`.)

Anything marked "familiar" is always `.n-known` and gets no body section; for the other two tiers, whether it gets a section (`.n-focus`) or
only one line in ③ the primer (`.n-brief`) is decided by where that concept sits in the graph —
a peripheral prerequisite is worth three sentences even when it is marked "never encountered". **How that section is actually written is `writing.md` item 7**,
which gives a different opening position and a different weight of length for each of the three tiers.

The last row is the least conspicuous but most useful use of the interview data: **when the reader gets stuck, the margin note tells them where to turn back to.**

One more thing does not land in the report and must not be lost either: **the exact wording of the option description they selected**
(and anything they wrote themselves outside the options) **has to stay in the context** — when sub-step 5.2 prints the outline,
each chapter has to be tied back with the sentence they actually read and selected, not with a bare "tier: never encountered" thrown at them.
The tier names are our internal labels; they have not seen those three words once from beginning to end.
