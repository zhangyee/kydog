<p align="center">
  <img src="assets/kydog-mascot.svg" width="120" alt="KyDog">
</p>

<h1 align="center">KyDog</h1>

<p align="center">An AI agent desktop app built for the research workflow</p>

<p align="center">
  <a href="https://github.com/zhangyee/kydog/stargazers"><img src="https://img.shields.io/github/stars/zhangyee/kydog?style=flat&color=e4b363" alt="Stars"></a>
  <a href="https://github.com/zhangyee/kydog/releases"><img src="https://img.shields.io/github/v/release/zhangyee/kydog?display_name=tag" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-blue" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey" alt="Platform">
</p>

<p align="center">
  <a href="README.md">中文</a> · <b>English</b>
</p>

---

## Demo

![KyDog in action: running a skill through a full literature review](docs/images/kydog-demo.webp)

## What KyDog is

Literature MCPs added to a coding agent such as Codex or Claude Code can search the literature, but a coding agent's conversations and tool calls are designed around code generation and oriented toward producing a result, which does not suit reading papers while testing ideas. Most research work is searching, close reading, cross-checking, and writing. KyDog is a harness and agent shell I redesigned around that work, based on the needs of my own daily research.

KyDog's literature search is handled by two tools: fastpaper reaches academic databases through their APIs, and slowpaper reaches sources without an API through a browser built into the app. On top of these, KyDog provides workflow skills covering four stages (research, study, write, review), invoked by slash command. When a skill searches, it queries sources in parallel and follows citation chains; every cited paper is verified against its source and downloaded to the project's `papers/` directory. Reports come out as Markdown files and, like the paper PDFs, can be read and edited inside the app.

KyDog follows Openclaw's workspace design and assembles the system prompt from three files: `AGENTS.md` sets the working procedure, `SOUL.md` sets the persona and tone, and `USER.md` records who the user is and what they research. These files are how the agent keeps that information across sessions. All three can be edited directly, and by editing them you can shape a research assistant of your own.

## What can KyDog do?

- **fastpaper: sources reached through APIs** — a command-line tool bundled with the app that searches, looks up metadata, traces citations, and downloads PDFs. It currently supports 26 sources: arXiv, PubMed, PMC, Europe PMC<sup>[note 2]</sup>, OSF Preprints, Semantic Scholar, OpenAlex, Crossref, DataCite, DBLP, CORE, OpenAIRE, DOAJ, HAL, Zenodo, Unpaywall, INSPIRE-HEP, zbMATH Open, ERIC, OSTI.GOV, NASA NTRS, Hugging Face Papers, OpenReview, J-STAGE, OAPEN, NASA ADS<sup>[note 1]</sup>.
- **slowpaper: sources reached through the built-in browser** — the agent operates a browser built into the app to reach sources with no API. It currently supports 2 academic search engines (Google Scholar, Baidu Xueshu) and 9 open-access full-text sources (MDPI, Frontiers, PeerJ, ChemRxiv, SSRN, AGRIS, PubScholar, ChinaXiv, and the National Center for Philosophy and Social Sciences Documentation). When a CAPTCHA appears, the user solves it in the browser sidebar. For each tool's source list and what each source supports, see [Literature sources](docs/literature-sources.md) (in Chinese).
- **Verifiable citations, with the harness constraining LLM hallucination** — fabricated references and misattributed claims are researchers' biggest concern about using LLMs for literature search and paper writing. KyDog constrains this at the harness level: every DOI written into a report is confirmed at its source, claims cite the original text, and anything that cannot be confirmed is left out.
- **Research workflow skills** — covering four stages (research, study, write, review), invoked by slash command.
- **Broad coverage of the major models** — 20 built-in LLM providers, plus any OpenAI-compatible endpoint (local Ollama / vLLM / your own proxy). Subscription sign-in for Claude Pro/Max, ChatGPT (Codex), and GitHub Copilot; API keys for Anthropic, OpenAI, DeepSeek, Google Gemini, OpenRouter, Mistral, Groq, Cerebras, xAI, ZAI, Kimi, MiniMax and more; cloud access via Azure OpenAI, Amazon Bedrock, Google Vertex AI.
- **PDFs and Markdown, read and edited in place** — a built-in PDF reader and a WYSIWYG Markdown editor, so you don't have to switch between applications.
- **Local-first** — a project is just a directory on your own disk; retrieved papers and generated reports are written there. Sessions and settings live in `~/.kydog/`, with credential files forced to `0600`. No account required; KyDog does not collect your files or conversations (conversations are sent to the model provider you configure).

> **[note 1]** Google Scholar and Baidu Xueshu were dropped from fastpaper's source list in v0.3.1 after both platforms tightened API access. slowpaper now reaches them through the built-in browser (see the slowpaper item above).
>
> **[note 2]** bioRxiv and medRxiv are no longer separate sources: their API cannot search by keyword, so they are now searched through Europe PMC, which indexes nearly every preprint from both servers.

## Built-in skills

KyDog's skills are organized around the four stages of a research workflow:

```
research (scope & survey)  →  study (self-teaching)  →  write (drafting support)  →  review (self-check & verification)
```

### The one thing every output shares: citations that hold up

Every skill's instructions include these four rules:

- **Identifiers are confirmed at the source.** Every DOI, arXiv id, and PMID written into an output must be confirmed to exist in its source database; entries that cannot be confirmed are left out.
- **Claims cite their location in the source.** Numbers, effect sizes, and directions of conclusion are each located in a specific section of the original; evidence that cannot be checked against the original is left out; findings from the literature and the model's own inferences are labelled separately.
- **Verification level is recorded.** The appendix sorts the literature into three tiers (full text read, abstract only, not obtained), and any verification step that was not completed is noted as such.
- **Papers are downloaded locally.** The PDFs of papers cited in an output are saved to the project's `papers/` directory, so each one can be checked against the original.

### Research: topic selection and state of the field

| Command | Purpose | Approach | Output |
|---|---|---|---|
| `/research-ideation` | Topic assessment: judge whether a research idea is worth pursuing and whether it has been done | Works through the nine Heilmeier questions one by one (a research-project checklist from former DARPA director George Heilmeier: what you are trying to do, stated with absolutely no jargon; how it is done today and its limits; what is new and why it will work; who cares; what difference success makes; the risks; the cost; the timeline; and how success will be measured); searches the literature and sorts it into six categories (established findings, contested findings, null results, mechanisms, methodology, closest related work), verifying each paper at its source | An assessment — worth doing / needs narrowing / consider another direction — plus a set of adjacent topics and the PDFs in `papers/` |
| `/literature-review` | Literature review: survey the state of research in a field | Multi-round, multi-keyword, cross-source search; surveys first, then classics traced back through citation chains; separates foundational work, mainstream approaches, consensus and controversy, and recent progress, and explains how it differs from existing surveys | One Markdown file: the front half is Related Work prose ready to use in a paper (author-year citations plus a reference list), the back half is the search funnel, literature map, and verification report |
| `/research-frontier` | Frontier briefing: catch up on a field's progress over the past year | Limited to the past year's literature; analyzes the main research groups, how research directions have evolved, established assumptions under challenge, new terminology, and open disputes | A 1,500–2,500 word briefing for researchers in the field, without background, with every judgment citing its source |

### Study: learning concepts and methods

| Command | Purpose | Approach | Output |
|---|---|---|---|
| `/learning-deck` | Study report: learn an unfamiliar concept or method | Three rounds of interview determine which prerequisite concepts the user is missing, and only those are explained; searches surveys, tutorials, and foundational papers; uses the paper's own figures where they can be retrieved and otherwise redraws them as SVG from the original (data plots are never redrawn), noting the source of every figure | A self-contained HTML study report you can open offline — knowledge map, one section per concept (definition → what problem it solves → mechanism diagram → common misconceptions and boundaries → sources), method comparison table, terminology glossary, and a close-reading list |

### Write: drafting support

| Command | Purpose | Approach | Output |
|---|---|---|---|
| `/paper-summary` | Paper write-up: write a paper into your own | First confirms the purpose (placing it in related work, contrasting it with yours, borrowing or reproducing its method, using its limitations to justify your work), then writes text for that purpose | A paragraph in the conversation; no file is written |

### Review: review and verification

| Command | Purpose | Approach | Output |
|---|---|---|---|
| `/peer-review` | Review self-check: find the issues referees are likely to raise before you submit | Runs a simulated review: an overall judgment first (checking the argument chain link by link, searching for the closest prior work to assess contribution and novelty), discussing direction-level problems with the user first; then comments item by item, with dispositions (revise / defer / reject) confirmed by the user; real reviewer comments can also be fed in | A revision plan — overall judgment plus per-comment blocks (severity, disposition, location and "change to"), with every cited reference verified at the source |
| `/peer-review-response` | Peer review: write a formal referee report the authors can check | First summarizes the manuscript objectively, then gives the overall judgment and item-by-item comments, each with location, problem, why it matters, and a suggested fix; literature judgments ("already done / missing work / citation doesn't support the claim") are written only after search and source verification; items with no issues are recorded as "none identified" | A submission-ready review report — overall judgment, Major / Minor, could-not-assess items, the review's own limitations, and the references it cites |
| `/fact-check` | Evidence check: judge whether a claim is supported by evidence | Decomposes the claim into decidable sub-propositions and confirms the decomposition with the user; searches for both supporting and contradicting evidence; grades evidence strength by study design and sample size, **never by journal prestige**; checks every paper used as evidence for retraction (only where PubMed / PMC reach; anything outside is recorded as unchecked) | A five-level verdict (holds / holds conditionally / insufficient evidence / contradicting evidence / does not hold) with the conditions under which it holds, plus an 800–1,200 word report |

## Installation

Download the installer for your platform from [Releases](https://github.com/zhangyee/kydog/releases). macOS (Apple Silicon / Intel) and Windows x64 are currently provided.

### First launch on macOS

The MVP is not yet Apple-signed or notarized, so Gatekeeper blocks the first launch:

1. System Settings → Privacy & Security
2. Scroll to the bottom and click **Open Anyway** under "KyDog was blocked"

If it still won't launch (occasionally on macOS 15.1+), run this once in a terminal:

```bash
xattr -d com.apple.quarantine /Applications/KyDog.app
```

### First launch on Windows

1. Double-click the `.exe`. SmartScreen will warn you → click **More info** → **Run anyway**
2. KyDog's shell tooling needs [Git for Windows](https://git-scm.com/download/win). If it isn't installed, KyDog prompts you on first launch — install Git, then restart KyDog
3. Quit KyDog completely before installing a new version by hand. If the installer hangs on the extraction screen and running Setup again doesn't help, or KyDog won't start after installing: end every **KyDog.exe** and **Update.exe** in Task Manager, press Win+R, open `%LOCALAPPDATA%`, delete both the **SquirrelTemp** and **kydog** folders, then run Setup again with a normal double-click (not as administrator). Your data lives in `C:\Users\<you>\.kydog` and is not touched. Details: [Windows install troubleshooting](docs/windows-install-troubleshooting.md) (in Chinese)

### Building from source

Requires Node.js ≥ 22.12:

```bash
git clone https://github.com/zhangyee/kydog.git
cd kydog
npm install
npm start
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the rest.

## TODO

These features are on the development plan:

- [ ] **More skills** — extending along research → study → write → review. Today research has three, study one, write one, review three.
- [x] ~~**PDF annotation** — highlighting and notes, plus Chinese translation and side-by-side bilingual reading.~~
- [ ] **Follow-up questions and citation commentary on documents** — ask about a selected passage right inside the Markdown editor, and get commentary on the references it cites.
- [x] ~~**slowpaper: in-app browsing** — let the agent drive a browser inside the app, reaching more literature sources that require browser interaction.~~
- [ ] **CARSI sign-in** — sign in automatically with a university account through CARSI (the Chinese education and research network's federated identity service) to reach the literature databases your university subscribes to.
- [ ] **A LaTeX editor** — an editing and compilation experience along the lines of Overleaf.

Feature requests and feedback are welcome in [Issues](https://github.com/zhangyee/kydog/issues). [Sponsoring the project](#supporting-the-project) helps speed all of this up.

## Acknowledgements

KyDog stands on the shoulders of these projects.

**Architectural core**

- **[Pi](https://github.com/earendil-works/pi)** — Mario Zechner. KyDog's agent loop is built directly on `pi-coding-agent`: LLM provider integration and credential management, the model catalogue, tool registration and execution, context management, and session persistence all come from it. On top of that, KyDog adds only its own tools (asking the user a question, driving the built-in browser, reading figures out of a PDF, reading Word documents directly), skill loading and locale projection, and the desktop event plumbing.
- **[Electron](https://github.com/electron/electron)** — the desktop shell. The main process runs Node and handles agent sessions, file I/O, and CLI invocation; the renderer runs Chromium and handles the UI, the PDF reader, and the Markdown editor; the two talk only over the RPC and event channels funnelled through `src/shared/protocol.ts`. Cross-platform packaging goes through electron-forge, and updates through Electron's `autoUpdater` against update.electronjs.org.

**Inspiration**

- **[Openclaw](https://github.com/openclaw/openclaw)** — Peter Steinberger. It writes agent configuration as Markdown files in the workspace directory that can be read, edited, and kept under version control. KyDog takes three of them — `SOUL.md` for personality and tone, `AGENTS.md` for working procedure, `USER.md` for who you are and what you're researching — to assemble the system prompt, which is also what lets you customize your own assistant by editing files.
- **[Open Scholar Skill](https://github.com/joshzyj/open-scholar-skill)** — Prof. Yongjun Zhang. A Claude Code skill suite for social scientists writing for top-tier journals: 35 skills decompose the whole chain — ideation, literature synthesis, hypotheses, research design, analysis, writing, submission, responding to reviewers — stage by stage, with mandatory human checkpoints at the critical ones. KyDog's research skills take their granularity and their confirm-before-acting approach from it; the comment triage in the review skills (dispositions first, applied after the user confirms) and the rule against widening the scope of changes during revision come from its scholar-respond.
- **[Academic Research Skills for Claude Code](https://github.com/Imbad0202/academic-research-skills)** — Edward Cheng-I Wu. Four skills forming a research → write → review → revise → finalize pipeline that keeps a human decision point at every stage instead of chasing full automation, with citation verification and claim-to-source alignment as their own audit passes. KyDog's four-stage split, and its hard rule that every citation must be verified against its source, both found corroboration here.
- **[Claude Academic Research](https://github.com/mronkko/claude-academic-research)** — Mikko Rönkkö. Its critic-loop grounds "when is the revision done" in checkable bookkeeping: every comment must have a recorded fate, and rejecting a Major has exactly two exits — a verifiable refutation, or the author explicitly ruling it out of scope. The disposition discipline in KyDog's review skills comes straight from here.
- **[Research Skills](https://github.com/neuromechanist/research-skills)** — Seyed Yahya Shirazi. Its paper-review requires every review comment to include five elements (location, problem, why it matters, suggestion, basis) and gives explicit severity criteria. KyDog's review skills adopt this comment structure and severity grading.
## Contributing

KyDog is developed and maintained by one person and badly needs feedback from real research work.

- **Feature requests and bug reports** → [Issues](https://github.com/zhangyee/kydog/issues). Specific feedback is especially welcome, for example a skill that doesn't work well in your field.
- **Code** → the development environment, directory layout, verification commands, and conventions are in [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests in English are welcome.

## License and privacy

Licensed under [GPL-3.0-or-later](LICENSE).

KyDog participates in anonymous usage statistics by default (a random install identifier plus app version, OS, and CPU architecture, at most once a day). It **does not send** file contents, conversation contents, project paths, filenames, or any personal information. You can opt out on the last page of first-run setup, and turn it off and delete collected data at any time under Settings → About → Privacy. Full details (in Chinese): [src/about/privacy.md](src/about/privacy.md). The server code is open for inspection: [kydog-telemetry](https://github.com/zhangyee/kydog-telemetry).

## Supporting the project

If KyDog saves you time, or you believe in where it's headed, a star helps.

Sponsorship is welcome too. The QR code is a WeChat one, so it's only usable inside China — see [支持这个项目](README.md#支持这个项目) in the Chinese README.

<!-- No star history chart: since 2026-06-30 GitHub limits the stargazers API to a repo's own
     admins and collaborators, so any third-party chart service needs a token with contents
     WRITE access (GitHub uses write to verify collaborator status; read-only is rejected).
     Not worth it. The badge at the top gives the current count. Revisit if an approach
     appears that doesn't require handing out write access. -->
