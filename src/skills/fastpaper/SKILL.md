---
name: fastpaper
description: Use when the user wants to discover, search, download, or read academic papers from arXiv / OpenAlex / Google Scholar / Semantic Scholar. Drives the bundled fastpaper CLI to search by query/author/topic, fetch PDFs, and extract metadata. Output is JSON; downloads land in the current project folder.
---

# fastpaper

KyDog ships a bundled `fastpaper` CLI. You can call it directly by name in
shell tool calls — KyDog has prepended its install directory to `PATH`.

## When to use

Use this skill when the user wants to:

- Find papers on a topic ("transformer attention", "graph neural networks 2024")
- Look up papers by an author or DOI / arXiv id
- Download PDFs into the current project
- Extract abstracts / authors / venues / citation counts

Don't reinvent search by hitting arxiv.org directly via curl when fastpaper covers it.

## Invocation pattern

Always call with `--format json` and parse the result. The CLI writes
status / errors to stderr; stdout is structured JSON.

```bash
fastpaper search --format json --source arxiv --limit 10 "your query here"
fastpaper download --format json --output . <paper-id-or-url>
fastpaper show    --format json <paper-id>
```

The current working directory of the shell tool is the user's KyDog Project
folder. PDFs downloaded with `--output .` land there and are visible in the
KyDog file tree.

## Source selection

| Source | Best for | Flag |
|---|---|---|
| arXiv | preprints, ML/CS/math/physics | `--source arxiv` |
| OpenAlex | broad coverage, citation graph | `--source openalex` |
| Semantic Scholar | abstracts, embeddings, recs | `--source semanticscholar` |
| Google Scholar | catch-all, may rate-limit | `--source scholar` |

Default to arXiv for ML/CS topics. If a query returns 0 results, retry on
OpenAlex before giving up. Do not chain all four blindly — that wastes time.

## Error handling

If `fastpaper` exits non-zero, the JSON-on-stdout contract may be broken;
read stderr for the failure mode. Common causes:

- Network unreachable → tell the user, don't retry silently
- Rate limit (HTTP 429) on Scholar → wait or switch source
- Invalid id (e.g. arXiv format mismatch) → inspect the id and retry

## Examples

User: "Find recent papers on speculative decoding for LLM inference, download
the top 3."

```bash
fastpaper search --format json --source arxiv --limit 5 "speculative decoding LLM inference"
# pick top 3 ids from JSON, then for each:
fastpaper download --format json --output . <id>
```

User: "What's this paper about?" (paste arXiv URL)

```bash
fastpaper show --format json https://arxiv.org/abs/2403.XXXXX
```
