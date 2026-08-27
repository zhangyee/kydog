# Writing requirements · writing.md

SKILL.md defines **which slots** the report has; this volume defines **what each slot should look like**.

The reason this volume exists is very concrete: v1 was actually run once (topic "fine-tuning ECG-FM for an AMI prediction model", 8468 characters / 93 paragraphs / 6 concepts),
not a single slot missing, entirely format-compliant, and after reading it the user's verdict was —

> The report as it stands really does read more like a reviewer's checklist than like self-study material.

So **every negative example below is verbatim from that real output**, not invented. The positive examples are rewrites of the same material,
so that you can see what "the same content, written acceptably" looks like.

**Read the seven requirements one by one, and finish them before writing any body text.** The "criterion" at the end of each is countable — once you have written it you can count it yourself.

---

## 0. The lesion, stated in one line

In that output's body: **"must" appeared 9 times, "should" 6 times, "cannot / may not / do not" 16 times**,
while **the whole 6-section report had only 1 `.example` block**, and that one held three unanswered questions.

That is the quantified form of "reviewer's checklist": **many rules, little explanation, almost no examples**.
What you are writing is a different thing — **something the reader can explain themselves afterwards**, not something that leaves them with a to-do list.

**Overall criterion: in ④ the concept body, imperative sentences aimed at the reader are capped at 3 per section, and appear only in
`.boundary` and `.checkout`.** Everywhere else writes "what happens", not "what you should do".

⑧ what to do next is **instructions from top to bottom** ("read §2–§3 closely", "write a minimal implementation on MNIST"),
and is not bound by this criterion — handing out actions is its entire job.
(v4 had a "③ fast track" here as well; v5 deleted it, see `references/layout.md`, "The four v5 changes".)

---

## 1. The one-line definition (`.lede`, which is also `.curtain-lede`)

⚠️ **Since v4 this sentence is the first element of `.concept`, with no `<h2>` before it**
(in the JSON it is the chapter's `lede` field, pasted at render time into both the curtain page and the body, see `references/deck-json.md`).
The chapter title and number appear only on the curtain page before it (`references/layout.md`, "The curtain page"),
and are not repeated in the body. That raises rather than lowers the bar on this sentence: **the subject has to name this section's concept**,
it cannot be written as "it is …" or "this step is …" — when the reader scrolls back from the middle of a chapter, nothing else on the screen
tells them what this section is about, and this sentence is the only way in.

**It must be a complete declarative sentence**: the subject is this section's concept, and the predicate says **what it is**.
Not an imperative, not a list of requirements, and not the tautology "X is a method used for X" that only rephrases the word.

**Negative example (v1 §4, verbatim)**

> Do not bet straight on full fine-tuning: only by comparing linear probing, partial unfreezing, full fine-tuning and a randomly initialized baseline in turn on exactly the same data split can you tell "pre-training works" apart from "the model is big enough".

That is an imperative plus an experimental plan, not a definition. After reading it the reader still does not know what a "fine-tuning strategy" is.

**Negative example (v1 §6, verbatim)**

> AUROC answers only ranking ability; an AMI model must also report AUPRC, sensitivity/specificity, PPV/NPV, calibration and confidence intervals, and pick a threshold in advance according to clinical use.

That is a to-do list. Of v1's 6 `.lede` sentences, 3 (§4 / §5 / §6) are not definitions of the section's concept.

**Positive example (the same material rewritten)**

> A fine-tuning strategy is exactly **the decision about which parameters of the pre-trained model change along with your data**: from "none of them change, only the last classification head is trained" to "all of them change together" there is a continuous ladder, and the further up you go the better it adapts to your data and the easier it is to forget what pre-training learned on a small sample.

**Criterion**: strip away all the context around this sentence and read it alone — it answers "what is the thing this section is about";
the sentence contains no "must", "should" or "do not"; it contains no new term this section has not explained yet (see item 6);
**the sentence contains the name of this section's concept** (the ⚠️ above).

⚠️ `.curtain-lede` and `.lede` **are the same sentence, word for word**, not one sentence each. Change one and change both.
Details are in `references/layout.md`, "The curtain page".

---

## 2. What problem it solves

**First describe what people did before it existed and where they got stuck, then what it does.**
A concept only stands up once the difficulty it solves has been made clear — the reader has to feel the pain before they will learn the painkiller.

**Three shapes that fail**: writing only "doing it that way used to go wrong" without saying why people did it that way;
a hypothetical mood throughout ("might … might …") without one thing anyone actually did; jumping straight to "you should …".

**Negative example (v1 §4, verbatim)**

> Freezing too much may fail to adapt to hospital equipment and AMI semantics; unfreezing too much may overfit on small data and forget the pre-trained representation. Running a single configuration, however high the AUROC, tells you nothing about whether the performance comes from pre-training, from parameter count or from sampling bias.

Two symmetrical "may" sentences, with nobody actually having done anything. After reading it the reader has no idea how this problem was discovered.

**Positive example (v1 §1, verbatim — v1 got this one right, follow it)**

> Before there is an explicit label, the most common practice is to take the discharge diagnosis code, the machine ECG interpretation or the string "MI" in the chart. This mixes prior infarction, acute myocardial injury, STEMI/NSTEMI and different MI types together, and even writes the ECG interpretation that the model is supposed to predict into the label, producing a circular definition.

"The most common practice is …" — it says what people **actually do** first, and only then what is wrong with it.
(It is still one step short: it does not say what a model built that way looks like. Add "so the model gets AUROC 0.94 on the test set
and drops to 0.71 at another hospital" and this passage is complete.)

**Criterion**: this passage can point at **one specific old practice that someone really used**;
words like "may", "often" and "easily" appear at most 2 times in it.

---

## 3. Mechanism

**Give an intuition that can be run in your head first, then the formal description.** The intuition can be an analogy, an extreme case,
or an example small enough to work out by hand. The formalism only has somewhere to land once the intuition is there.

**"Mechanism" is not "operating steps", and it is not "here is what I suggest you do".**
This is where v1 failed most consistently: it wrote "mechanism" as an implementation plan.

**Negative example (v1 §1 "mechanism", verbatim)**

> First draw the "prediction time point — evidence window — outcome" timeline. It is recommended to define the main task as: at first clinical contact or a designated emergency time point, using only the 12-lead ECG already obtained by then, predict AMI as subsequently adjudicated by the full clinical evidence. Labels may be reviewed independently by two people with a third resolving disagreements; if only structured data can be used, an auditable algorithm has to be written out in advance and spot-checked by hand.

"First draw …", "it is recommended to define …", "has to be written out in advance …" — that is a plan for a project lead, not a mechanism.

**Negative example (v1 §5 "mechanism", verbatim)**

> Cluster by patient first, then split by time; all preprocessing statistics, missing-value rules, resampling choices, class weights and calibrators are fitted on the training/validation data only. The test set is locked once.

That is an SOP again. A reader who follows it gets the right result but does not know **why** — so in a different setting they will still get it wrong.

**Positive example (the same material rewritten, §5's mechanism)**

> Imagine an extreme case: the dataset has only 10 patients, 100 ECGs each, 1000 in total. Split it randomly 9 to 1 by ECG and
> the training set takes 900 — those 900 almost certainly cover all 10 patients. For every one of the 100 in the test set,
> the model has already seen 99 others from **the same person** during training. So the model can score full marks just by learning to "recognize people":
> recognize that this is patient 3, and patient 3 is positive, output 1.
> That is exactly what leakage is — **something in the test set that the training set has seen and that carries information about the label**.
> Patient is the coarsest one; serial ECGs from one visit, and the batch fingerprint of one machine, are finer versions of the same thing.
> "Group by patient" is the first gate because patient ID is the widest stretch of that shortcut, and the easiest to block.

**The intuition has to land on a formalism.** With only the analogy and no equation, no structural diagram, no procedure,
the reader comes away with an impression and still cannot match it to the paper — that is popular science, not self-study material.
What the positive example above has to be followed by is: "Formally, leakage is a shared variable g in the joint distribution of the
training and test sets that carries information about the label (patient ID, visit ID, device batch);
`GroupKFold(groups=patient_id)` is what makes g disjoint across the two."

**Criterion** (both halves must pass):
1. The **first paragraph** of the mechanism part contains an analogy, an extreme case or a minimal example — **one of the three**;
2. that part **also** contains one formal landing point — an equation, a structural description, or the procedure matching that figure in the original,
   and it is about the same thing as the intuition in the first paragraph;
3. nowhere in the passage does a chain of instructions appear, of the "it is recommended", "you should define … as", "do A then B" kind;
4. the caption of the SVG that goes with it says **which step of the mechanism this figure is about** (not a restatement of the title).

---

## 4. At least one concrete example per section

**At least one `example` block per chapter** (`blocks[].type === "example"` in the JSON), and it must hold one of these three:

1. one worked calculation or one set of values with **concrete numbers**;
2. one **concrete input → output**;
3. one **contrast of "what it looks like when it goes wrong"** (done right it is like this, done wrong it is like that).

**Negative example (v1's only `.example` block in the whole report, verbatim)**

> Three sentences to write into the plan first: who the target population is; how the index ECG relates to symptom/arrival time; by what evidence, within what time window, and by whom AMI is adjudicated.

Those are three unanswered questions, not an example.
The report is not short of numbers (90.9M parameters, 1.5 million ECGs, 500 Hz all appear), but those are **the paper's parameter table**,
not examples — **nowhere does it substitute concrete numbers and work through them, and nowhere is there a "right like this, wrong like that" contrast**.

**Positive example (an acceptable example for the same section)**

> **For example**: the same patient arrives at the emergency department with chest pain on 2024-03-11, has a first ECG at 18:42, a repeat at 19:20,
> and one more before discharge at 09:05 the next day, with adjudication finally calling it NSTEMI.
> Under "take the first one", this case contributes 1 positive sample, with the 18:42 ECG as input;
> under "take them all", it contributes 3 positives — and the 09:05 one is **after reperfusion**,
> its ST segment already back down, so the model learns "looking normal can also be AMI", which is precisely the route by which label noise gets poured in.
> The two practices differ by one `groupby().first()` in code, and by what the model learned in the result.

**Criterion**: **at least 1** block with `type === "example"` in each chapter's `blocks`
(item 5 of the JSON self-check in `references/deck-json.md`, verified at sub-step 5.4,
when the HTML does not yet exist — if it fails, go back and change a few lines of that chapter's JSON);
every `example` contains at least one Arabic numeral or one contrast.

⚠️ **A pointer card does not count**, it is a different `type` (`pointer`, see `references/figures.md`),
so the count above naturally never reaches it. Do not write a pointer card as an `example` to pad the count —
a card reading "Fig. 2 of that paper shows … + DOI" can carry numbers and slip past both criteria,
while being precisely the opposite of a "concrete example".

**One more countable rule**: **abstract propositions may not run for more than three paragraphs in a row**.
If you reach a fourth paragraph with no concrete number, concrete object or concrete contrast, stop and insert an example —
it need not be an `.example` block; one sentence in the body, "for instance when T = 1000 …", also counts.

---

## 5. Common misconceptions and limits (`.boundary`)

**Every item must carry a concrete counter-case.** "Do not assume X" is not a limit, it is a slogan — the reader nods and then makes the same mistake.
An acceptable limit looks like this: **the misconception → one concrete situation that punctures it → so the correct understanding is this**.

**Negative example (v1 §6, verbatim)**

> 0.5 is not a natural threshold. The threshold depends on the cost of missed and false alarms, on the workflow and on prevalence.

**Negative example (v1 §4, verbatim)**

> Class weighting is not calibration. A weighted loss changes the optimization objective, and the output probabilities usually need recalibrating on a separate validation set.

**Negative example (v1 §2, verbatim)**

> z-score is not a harmless step. You must check whether the statistics are per lead, per record or per dataset; do not implement it from the name alone.

All three are assertions and nothing else. The third is the biggest waste — what it looks like when you get "per lead or per record" wrong could be said in one sentence, and it does not say it.

**Positive example (the same item rewritten)**

> **"0.5 is the natural threshold"** — it is not. Suppose AMI is 8% of the emergency chest-pain population and your model has sensitivity 0.62
> and specificity 0.96 at 0.5. That sounds fine, but it misses 38% of the real infarctions: 80 AMIs among 1000 patients, 30 of them missed.
> Push the threshold down to 0.15 and sensitivity rises to 0.95 (4 missed), at the cost of specificity dropping to 0.71 — 267 extra false positives,
> which is 267 extra unnecessary consultations. **Which is worse is not a statistics question, it is a department question**,
> so the threshold has to be fixed by intended use before the test set is locked.

**Criterion**: every `.boundary` item can point at a **concrete situation, concrete number or concrete contrast**;
an item that only has "is not", "is not the same as" or "cannot" with no situation after it is unfinished.

---

## 6. Terminology

**Give every term one plain-language sentence the first time it appears.** A complete sentence, not the half-clause in an appositive
("latent tokens (potential word elements)" is not an explanation, it only swaps English for Chinese).

**At most two new terms per paragraph.** Over that, split the paragraph, or demote some of them to ③ the primer.

**Negative example (v1 §3 "mechanism", verbatim)**

> The original model has about 90.9M parameters: four CNN layers compress the waveform into latent tokens, 12 Transformer layers produce contextualized local representations, and average pooling gives a global vector. Pre-training carries three signals: a wav2vec 2.0-style masking task biased toward the local, CMSC treating adjacent segments of the same ECG as a positive pair to learn global stability, and RLM randomly masking leads.

Four new terms in one paragraph — **latent tokens, wav2vec 2.0, CMSC, RLM** — with half a clause of annotation each.
Worse: **not one of those four appears in the 8 entries of ⑦ the glossary**, so a stuck reader has nowhere to fall back to.

**Positive example (the same material rewritten, split into two paragraphs)**

> This model comes in two halves. The first half is four CNN layers, whose job is **to cut the continuous waveform into a string of fixed-length chunks** —
> like cutting a recording into frames and compressing each frame into a vector. In the literature these vectors are called **latent tokens**,
> and the word "token" is borrowed from natural language processing, where one token is roughly one word, while here one token
> is roughly a few tens of milliseconds of waveform.
>
> The second half is 12 Transformer layers, whose job is **to let every token look at the other tokens**:
> frame 40 can refer to frame 3 directly, instead of passing it along step by step as an RNN would. Relations across beats and across leads are composed exactly this way.

**Criterion**: the first appearance of a term gets `.term` and a link to ⑦ the glossary (see `references/layout.md`);
**⑦ the glossary must cover every abbreviation that appears in the body** — when you are done, take each capitalized abbreviation from the body and search the glossary for it;
if it is not there it was missed. Count new terms paragraph by paragraph; no more than 2.

---

## 7. Depth by interview tier

The interview sorts every concept into three tiers (see `references/interview.md`). **The tier has to genuinely change how the section is written**,
not just get a mention in the `.aside`.

| Interview tier | Where this section starts | Where the length goes |
|---|---|---|
| **never encountered** | Start from the **motivation**: why this thing exists at all, what the world without it looks like | Item 2 (what problem it solves) has to be longer than in other sections, and the mechanism can be one tier shallower |
| **heard of it, cannot explain** | Skip the motivation, **go straight into the mechanism**: they already have an incomplete picture, and your job is to fill in lines and fix errors | Item 3 (mechanism) + item 5 (limits) carry the weight |
| **familiar** | **Do not write this section.** It appears only in ② the knowledge map as an already-known node, linked to the glossary | — |

**Negative example (v1 §3 `.aside`, verbatim)**

> Transformer was "never encountered" in the interview; read the primer first, this section does not require deriving the attention formula.

It **stated** the tier and then wrote the body exactly as before — §3 is in fact the most term-dense section in the report (see item 6),
while Transformer gets three sentences in ③ the primer. Marked "never encountered", it actually got less than the others did.

**Positive example**: for the same "never encountered", this section's "what problem it solves" should start from
"before Transformers, processing a sequence meant passing information down step by step, and using information from step 3 at step 500
meant 497 handovers in between, by which point it had worn away", not from parameter counts and layer counts.

**Criterion**: in a section marked "never encountered", the item-2 part is **no shorter than two paragraphs**, and the first paragraph contains none of this section's core terms;
in a section marked "heard of it, cannot explain", the body reaches the mechanism **within three paragraphs** after the first `h3`.

---

## 8. Length

**This report has no length cap** — that is the user's explicit decision. v1's roughly 1400 characters per section was the model holding itself back.

**Do not cut examples, intuitions or term explanations to control length.** Once the seven items above are satisfied it will naturally be longer than v1,
and that is right. What is actually holding you up is those seven items, not the word count.

The converse holds too: **length is not the goal**. The extra length goes into examples and intuitions, not into listing a few more requirements.

---

## 9. Self-check when finished (read it, do not grep it)

The structural criteria are in "JSON self-check" in `references/deck-json.md` (verified item by item by reading the JSON,
run at sub-step 5.4), and the post-render greps are in "Pre-delivery self-check · HTML layer" in `references/layout.md`;
the items below can only be checked by reading, **at sub-step 5.4, that is, while you are still on the JSON** —
at that point changing a passage is changing one line of JSON:

1. Pick any section and **read it from `.lede` through to `.checkout`**, then ask yourself: could I now explain this concept to somebody else?
2. Count the `example` blocks: **at least one per chapter**, and each with a number or a contrast in it.
3. Count the imperatives: **at most 3 per section**, and all of them inside `.boundary` / `.checkout`.
4. Count new terms paragraph by paragraph: **no more than 2**; every abbreviation in the body can be found in ⑦ the glossary.
5. Find the longest run of abstract paragraphs in the report: **no more than 3**.
6. In the sections marked "never encountered", check whether the first paragraph starts from the motivation.
7. Check whether any `<h2>` has slipped into `blocks[].html` — the chapter title appears once, on the curtain page,
   and writing it again in the body is exactly what v4 de-duplicated, see `references/layout.md`, "The curtain page".
   (`.lede` is a fixed chapter slot whose position is fixed by the renderer, so it needs no further checking.)
8. Check whether chapter numbering uses only the one form `§N` throughout, and that `§` is not used on auxiliary sections like ⑤ and ⑥.
