# Web research report template

This is a structural constraint, not a fixed section list. Add or remove sections under “Topical findings” as the research question requires. Keep the other sections so readers can see the scope behind the conclusions and what remains unresolved.

```markdown
# {{Research topic}}

> Original question: {{the user's original question}}
>
> Search date: {{YYYY-MM-DD}}

## Conclusion summary

Answer the question directly in short paragraphs, distinguishing verified conclusions, conditional judgments, and remaining uncertainty.

## Topical findings

### {{Topic determined by the question}}

State concrete findings. In the draft, write `[Source title](finalURL)〔证据:evidenceId〕`. Multiple evidence items from the same source may use `[Source title](finalURL)〔证据:id1,id2〕`; use separate links for different sources. `complete` removes the internal IDs after validation.

## Conflicts and unverified items

- State conflicts between sources and version or date boundaries.
- State leads supported only by search snippets, fetch failures, or questions that lack enough evidence.

## Method and coverage

- Search engines actually used and the query range.
- Counts of enqueued, processed, evidence-ready, irrelevant, failed, and unprocessed sources. Do not present the fetch-budget ceiling as a planned source total.
- Key selection rules and uncovered language, date, or site ranges.

## Limitations and open questions

Record questions without an actionable search path and the effects of budgets, access limits, or source quality on the conclusions.
```

The published report keeps only clickable `[Source title](finalURL)` links. It must not contain `evidenceId`, `sourceId`, `claimId`, or other internal keys. A page read directly in IAB but not entered into the evidence ledger must use an ordinary URL link labeled “read directly in this run; not included in body evidence.”
