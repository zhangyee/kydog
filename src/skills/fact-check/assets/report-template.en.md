# Verification: <one-line summary of the claim>

> **Verdict: <holds / holds conditionally / insufficient evidence / counter-evidence exists / does not hold>**
> broken into <N> sub-claims | searched <N> sources with <N> queries | <N> pieces of evidence entering the verdict

<date>

**The original words being checked**

> <the claim as the user gave it, quoted verbatim, do not rewrite it for them>

---

## 1. The verdict

> One or two paragraphs. **Must carry a boundary**: within what range it holds, beyond what range there is no evidence.
> Academic claims are almost never unconditional, and a verdict without a boundary is essentially always wrong.
> Cite specific studies (author year), do not point to this report's own sections.

<the verdict text>

---

## 2. The sub-claims one by one

> For each, an experiment that could falsify it must be imaginable. The type decides the criterion:
> existence holds once one paper is found; universality is overturned by one counterexample; causal needs interventional evidence;
> quantitative and comparative must be decided together with their conditions.

### Sub-claim 1: <the decidable statement>

- **Type**: <existence / universality / causal / quantitative / comparative>
- **Verdict**: <one of the five levels>
- **Supporting evidence**: <Author (year), Full Title> — <study design>, <sample/population>, <key result>
- **Counter-evidence**: <same format as above; where none was found write "deliberate search found none", and state in section 3 what was searched>
- **Why this verdict**: <one or two sentences>

### Sub-claim 2: …

---

## 3. Counter-evidence search record

> **This section cannot be dropped.** Looking only for supporting evidence is confirmation bias — the reader must be able to see that you really did look for the other side.

- Negation-phrase search: searched <keywords> in <sources>, <result>
- Citation-chain tracking: ran `cite --direction incoming` on <the key supporting paper>, <whether a later refutation exists>
- <where a sub-claim's counter-evidence search turned up nothing, state the search scope here, so the reader can judge whether there really is none or you did not find it>

---

## 4. Evidence list and check record

| Paper | Full title | Year | Study design | Retraction check | Source check |
|---|---|---|---|---|---|
| Author et al. | | | meta-analysis / RCT / cohort / retrospective / case report / preprint | checked, not retracted / checked, **retracted** / **cannot be checked in this field** | p. N <section name> |

> **The retraction-check column must not be left blank.** Checked means write checked; where it cannot be checked write "cannot be checked in this field" —
> `retracted publication[pt]` works only on pubmed/pmc.
> Pretending to have checked is the most dangerous error in this report.
>
> Evidence that cannot be verified against the source enters neither this table nor section 2.

**Which checks were actually done this time**

- Search stratified by study design: <done / not done, because <reason>>
- Retraction check: <done for N papers / cannot be checked in this field>
- Dedicated counter-evidence search: <done>
- Source-text check: <N against full text, N abstract only>
- Extreme-value re-verification of in-query filters: <result>

## 5. The boundaries of this check

- Sources covered: <list>. Not covered: <list>, so <some kind of evidence> may have been missed.
- "Not found" means only not found in the sources and queries above; it **does not equal nonexistent**.
- No impact factor and no journal-tier data; evidence strength is judged by study design and sample, not by a journal's reputation.
- <where the verdict is "insufficient evidence", state here which kind it is: nobody has done it / it has been done but this endpoint was not reported / the search may not have covered it>
