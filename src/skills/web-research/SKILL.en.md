---
name: web-research
description: Use when the user needs current web information, confirmation of new software documentation, software architecture research, or technology trends in a traceable web research report.
---

# Web Research

Write the output as a **Markdown research report** in the user's language. Inputs are HTML and plain-text web pages; do not read PDF bodies. Search engines are operated only through KyDog's IAB `browser_open` and `browser_act`; `web_research_collect` fetches only target URLs already discovered there.

## 1. Scope the question

Preserve the user's original question. Define research angles with explicit `id`, `label`, and `query`; add `rationale` when the choice needs explanation. State relevant versions, publication period, and criteria for a useful answer. Use the tool's default budget unless the user specifies one; do not silently raise limits.

## 2. Discover across IAB search engines

Read the relevant engine cards under this skill's `references/` first. DuckDuckGo search and requery, and Bing direct results-page entry and one result extraction, have been verified in KyDog IAB. Google and Baidu result structure and requery were probed in Chrome, but KyDog IAB reached challenge pages on the tested network exit; IAB result extraction remains unverified. By default, try the same `query` separately on DuckDuckGo and Bing. If the user specifies another engine, attempt it using its card and record results or blocking from the **current IAB response**. Never claim results that were not extracted.

For each search, retain a unique `attemptId`, `engineId`, unchanged `query`, `angleIds`, search-page URL, and status. For every candidate extracted with `browser_act`, retain its attempt, angle, engine, query, title, snippet, and target `@href`. Preserve every discovery when multiple engines find the same target. Use `explicit_empty` only when the page explicitly reports no results; mark a challenge as `blocked`, and distinguish navigation from extraction failures. Zero extracted rows do not prove zero search results. Do not nominate obvious PDF links for body collection; if a target actually responds with PDF media, the collector marks it unsupported.

Search snippets can guide the next search before full pages are read. Requery when an observed ambiguity, contradiction, or missing version document warrants it. The observations and research gaps determine whether another round is needed; **there is no preset round count**. Snippets are discovery clues, never final evidence.

## 3. Collect in batches and continue

Send `originalQuestion`, `angles`, `enabledEngines`, `attempts`, and `discoveries` to `web_research_collect`. Do not pass a thread ID; the tool binds the current conversation. You may collect one batch, then search again from the returned angle summaries and `gaps`. For continuation, pass the returned `researchRunId` with new attempts and discoveries while preserving the original question. Set `refresh: true` only when refreshing already collected pages is explicitly requested.

The collector owns URL deduplication, budgets, redirects, concurrent fetches, isolated extraction, and quote verification. Only compact claims, evidence IDs, source states, and gaps return to the main conversation; do not paste entire pages into it. Keep fetch failures, challenge pages, PDF media, and incomplete model work as limitations rather than labeling them irrelevant.

## 4. Verify and report

Call `web_research_evidence` for evidence IDs you intend to cite, at most 4 per call. Check the saved excerpt, final URL, and support or contradiction relation. Only `grounded` quotations from source text support concrete conclusions. Present conflicting sources side by side; do not vote by search-engine hit count. The report should cover the question, method and search scope, findings, source links for specific claims, conflicts, and open gaps. Place the final URL and evidence ID beside each concrete claim. Search hits whose body was unavailable or unread are limitations, not cited evidence.
