# The Nine Heilmeier Questions

The checklist George Heilmeier laid down while running DARPA in the 1970s: everyone coming to apply for funding had to answer these nine questions. It went on to become the classic standard for assessing research projects in science and technology, still in use at DARPA today, and used as well by many universities' proposal defenses and by companies' project approval reviews.

Its power lies not in how profound any one question is, but in **asking all nine together**. Any one of them alone looks like common sense, but a topic genuinely thought through can answer all nine, while a topic not yet thought through always jams at one or two of them — and where it jams is exactly where it most needs work.

For each question below: **the original question / what it tests / what a good answer looks like / the common bad answers / which dimension to grab when drafting candidate options**.

---

## Q1 What are you trying to do? Say it in plain language with no jargon at all

**What it tests**: whether you have genuinely thought it through. This is the hardest and the most famous of the nine. Heilmeier's own words: if you cannot explain it in language an ordinary person understands, you have not thought it through yourself.

**A good answer**: one to three sentences an undergraduate who never studied this field can follow. Precision may be traded away for clarity.

**A bad answer**: the paper title rephrased. Three technical terms explaining a fourth. "We propose an X-based Y framework for the Z task" — every word is jargon.

**Dimension for drafting candidates**: give 2–3 phrasings at **different levels of abstraction**. For instance one close to everyday experience ("want to work out why the same drug does nothing for some people"), one in between, and one closer to their own words but with the jargon already stripped out. Let them pick the altitude they are comfortable at.

**Special handling for this question**: once it is settled, read it once more yourself and point out the jargon still left in it. This is the most valuable output of the whole of Step 1 — many users, pressed on this one sentence, discover for the first time that what they want to do and what they say are not the same thing.

---

## Q2 How is it done today? What are the limits of current practice?

**What it tests**: whether you know the field you are about to enter. "Innovation" that does not know the status quo is usually duplicated labor.

**A good answer**: can name the current mainstream approaches (better still, can name representative work), and says clearly **which step exactly** the limit jams at.

**A bad answer**: "existing methods are not accurate enough", "traditional methods are inefficient" — true of any field, which is to say nothing.

**Dimension for drafting candidates**: this question leans on the scouting search more than any other. Build the options out of the real papers you just found: write each of the 2–3 technical routes that actually exist in the field as one option, with its known limits attached. **Do not invent the mainstream approach from memory** — in an obscure direction this is where hallucination shows up most easily.

---

## Q3 What is new in your approach? Why do you think it will succeed?

**What it tests**: whether the novelty genuinely exists, and what the odds of success rest on. Both sub-questions must be answered.

**A good answer**: the novelty points to one concrete difference (a different way of measuring / a data source previously out of reach / two formerly unrelated methods joined up). The odds have grounds — a pilot experiment, a precedent in an adjacent field, some new condition that has just matured.

**A bad answer**: "we are the first to apply deep learning to this problem" (usually untrue). "We combine the strengths of A and B" (why does combining produce strengths). The odds part written as only "we believe".

**Dimension for drafting candidates**: separate out the **type** of novelty — is it new data, a new method, a new object, or a new combination? The four have entirely different risk structures, and which one is picked directly shapes the Step 3 assessment.

---

## Q4 Who cares? If it works, who does it matter to

**What it tests**: whether the audience concretely exists. This question is what blocks projects that are "technically interesting but nobody needs".

**A good answer**: can name a concrete group or role, and **can say what they are putting up with right now for lack of this thing**.

**A bad answer**: "of significance to both academia and industry". "Benefits society".

**Dimension for drafting candidates**: give options at **different audience breadths** — a very narrow, very concrete one ("labs running X experiments, who hand-annotate for two weeks each time"), a middling one, and a broad one. The narrow one is usually more convincing, and easier to verify in Step 3.

---

## Q5 If it succeeds, what difference will it make?

**What it tests**: the magnitude and the shape of the impact. The difference from Q4: Q4 asks "who", Q5 asks "into what".

**A good answer**: can state a before-and-after that can be compared, better still with an order of magnitude (two weeks becomes two hours / from measuring only 3 sites to measuring all of them).

**A bad answer**: the Q4 answer said over again in different words. "Will advance the development of the field".

**Dimension for drafting candidates**: **the type of change** — does it make possible what could not be done before, make cheap what used to be expensive, or overturn a conclusion everyone took to be right? The three are verified in different ways.

---

## Q6 What are the risks?

**What it tests**: whether you have seriously thought about how it fails. A project that cannot state its risks usually has not thought of the failure paths, rather than genuinely having no risk.

**A good answer**: 2–4 concrete failure paths, each able to say **how it would be noticed if it happened**.

**A bad answer**: "the main risk is not enough time". "The technical difficulty is fairly high".

**Dimension for drafting candidates**: split by the **source** of the risk — the data cannot be obtained / the method itself may not hold / the effect size is too small to detect / someone else gets there first / ethics or compliance blocks it. Let the user pick the kind they genuinely worry about. Step 3 sets this answer against boxes 2 and 3 of the literature, to see whether what they worry about and what the literature shows are the same set of risks.

---

## Q7 How much will it cost?

**What it tests**: a realistic sense of resources.

**Transposed for the academic setting**: most research users cannot answer with a dollar figure, and should not be forced to invent one. Turn it into **resource scale**: person-months, compute (GPU hours), sample size, the equipment or dataset access required, whether a collaborator is needed.

**A good answer**: can say what the single most expensive item is, and whether it is at hand now.

**A bad answer**: "no extra funding is needed" (almost always untrue — there is at least someone's time).

**Dimension for drafting candidates**: split by the **bottleneck resource** — mainly people / mainly compute / mainly samples and data / mainly equipment and access. Which one is the bottleneck directly decides how feasibility gets judged in Step 3.

---

## Q8 How long will it take?

**What it tests**: whether the timescale matches the goal.

**A good answer**: a total duration, plus when the first verifiable milestone falls.

**A bad answer**: a whole number of years, with no intermediate milestone.

**Dimension for drafting candidates**: **the timescale** — one semester / one year / a PhD cycle (3–5 years) / longer. Read it together with Q9's midterm milestone: if the total is four years and the first verifiable thing lands in year three, that is itself a risk and must be named in Step 3.

---

## Q9 What are the midterm and final exams for success? What is the measure of success

**What it tests**: how you will know you got there. The one of the nine most easily skipped, and the one that least deserves skipping.

**A good answer**: midterm and final **written separately**. Each is observable — a number, a demo that can be built, a result that can be reproduced. Better with a threshold ("beat the current best on the X dataset by 5 points" is far stronger than "achieve better performance").

**A bad answer**: "publish a high-quality paper" (that is an outcome, not a criterion). "Validate the effectiveness of the method" (what counts as effective).

**Dimension for drafting candidates**: split by **the type of measure** — a quantitative metric crossing some threshold / a demonstrable prototype built / reproducing a known phenomenon and then pushing one step past it / falsifying an existing hypothesis.

**If the user skips this question**: that is a red flag and must be written into the Step 3 assessment. With a topic that cannot state a success criterion, three years on nobody (themselves included) can judge whether it was achieved. Do not fill in a measure for them — let that blank stay in the report where it can be seen.

---

## General rules for drafting options

1. **Options are candidate answers, not meta-choices**. "There is a baseline to compare against / only a qualitative description / have not thought about it" are meta-choices, carrying very little information about a specific topic. "Can compare GDT-TS against existing methods on CASP / can only judge structural plausibility by eye" — those are candidate answers.
2. **The options must genuinely differ from each other**. If two options differ only in wording, it makes no difference which the user picks and the question was asked for nothing. Either different positions, or different levels of abstraction, or different scopes.
3. **Mark `recommended` on the one you genuinely endorse most**, not on the most middle-of-the-road one. The user will read it as your judgment.
4. **Do not fear a wrong option**. Rewriting a wrong option is easier for the user to think through than facing an empty input box — people know what they want best at the moment they are contradicted. That is the entire point of "draft first, then let the user change it".
