# CausalCI

**When CI goes red, CausalCI proves which commit caused it.** It ranks the suspects with a model trained on real regressions, re-runs the repository's own tests in isolated sandboxes with a flaky-aware search, and reports the culprit with its confidence and the evidence.

[![CI](https://github.com/SwethaatGH/CausalCI/workflows/CI/badge.svg)](https://github.com/SwethaatGH/CausalCI/actions/workflows/ci.yml)

Import a GitHub repository and CausalCI:

- ranks the commits most likely to have caused the problem, with **a reason and a source for every score**;
- shows exactly what changed, and which code depends on it, from a **call graph built from the TypeScript compiler**;
- has **Gemma 4** explain the evidence, with every answer checked against it;
- proposes fixes, checks them, and writes a shareable report.

![Overview: the most likely cause, what was checked, and where to look next](docs/screenshots/overview.png)

## Beyond the dashboard: finding the culprit for real

The UI explains suspects. The engine underneath **runs the repository's own tests in sandboxes and proves which commit broke the build**, and it was measured on real regressions, not a demo.

| | Result |
|---|---|
| **Learned suspect ranker** (184 real regressions mined with SZZ + reverts from 9 repositories in JavaScript, Python and Go; leave-one-repo-out) | culprit in the top 3 **65.8%** of the time (95% CI 58.7–72.8%) vs. 49.5% (42.4–56.5%) for the best baseline and 15% for random ([details](docs/EVALUATION.md#1-ranking-on-real-regressions)) |
| **Flaky-aware Bayesian bisection** (simulated suite with 5% false failures, 10% misses) | right **97.9%** of the time vs. 61.0% for `git bisect` ([details](docs/EVALUATION.md#2-search-under-flaky-tests-simulated)) |
| **Parallel k-way bisection** | wall-clock rounds 6 → 3 at 64 commits, 9 → 4 at 512 |

How it works:

1. **Range.** A red CI run on `main` (GitHub Action), a metric shift lined up with a deploy (change-point detection, `causalci signal`), or a range you give it.
2. **Rank.** A logistic-regression ranker trained on mined regressions orders the commits; the transparent risk signals explain each one.
3. **Search.** Bayesian bisection seeded with the ranking tests where the expected information gain is highest and stops at 95% confidence; k-way mode runs probes in parallel. Regression test selection over the call graph can narrow what each run executes.
4. **Sandbox.** Each run happens on a fresh checkout with no network, no capabilities, a non-root user, resource limits and optional gVisor. Dependencies (including workspace `node_modules`) are installed once per manifest-and-lockfile hash. In production every run is a hardened Kubernetes Job on a gVisor node pool ([threat model](docs/THREAT_MODEL.md)). The web app starts these runs too: **Confirm with tests** on Suspects, **Run the checks** on Fix and verify.
5. **Report.** Culprit, confidence, every run's result, a comment on the culprit commit, and an optional draft revert PR.

It runs as a CLI (`causalci`), a queue-driven service (API → Redis → KEDA-autoscaled workers, Prometheus and Grafana), and an **MCP server**, so coding agents can check their own changes. Design decisions are recorded in [docs/adr](docs/adr).


---

## Features

| Page | What it does |
|---|---|
| **Overview** | Where an investigation stands: the most likely cause, commits and functions checked, risk levels, top suspects, most-changed files and progress. |
| **New investigation** | Pick a repository by URL or `owner/name`, a branch and the commits to check. Five ways to search: **Recent commits**, **Between good and bad** (a known-good and a known-bad commit), **One commit**, **Browse history**, and **Describe the bug** (your symptoms decide which commits come first). Progress streams live. |
| **Suspects** | The ranked suspects. For each one: why it was flagged (labeled *code structure*, *pattern* or *commit info*), the evidence, an AI explanation, and how to confirm it. Statuses are honest: *confirmed by tests*, *likely cause*, *possible cause*, *not enough evidence*. |
| **Commit history** | Every commit in the range as a zoomable chain, with filters, search, playback, Shift-click to compare two commits, bookmarks and a per-file change trail. |
| **Compare commits** | Side-by-side or inline diff of a version that worked and one that's broken, with tabs for code, functions, file tree, dependencies, configuration and an AI summary of the behavior change. |
| **Impact map** | Which functions and files call or import the changed code, step by step, with what it affects, the tests that cover it, and the source. |
| **Ask AI** | Seven structured analyses (root cause, why it was flagged, behavior change, impact, tests, fixes, other explanations) at beginner, developer or expert level, plus a chat. Answers cite evidence; anything the model invents is removed and flagged. |
| **Fix and verify** | Three kinds of fix: the smallest fix (AI), reverting the commit (no AI), or adding tests. Preview, copy or download the patch, roll-back steps, and a check that re-runs the demo's tests on the fixed code. |
| **Reports** | Saved reports with the evidence, exported as Markdown, JSON or PDF. If something wasn't run, the report says so. |
| **Repository health** | Activity, contributors, files that change most, risk over time and hotspots. Not test coverage. |
| **Saved investigations** | Search, rename, reopen, duplicate and delete past work, with notes and bookmarks. |
| **Everywhere** | ⌘K search across commits, files, functions and findings; shareable links to any view; keyboard shortcuts; light and dark mode following your Mac; reduced-motion support; works on small screens. |

### Honesty rules built into the product

- Risk scores (0–100) are estimates. They are never shown as probabilities.
- Every finding cites its evidence: commit, file, line and code.
- Gemma's output is validated before it reaches the screen. Evidence the model invents is removed and flagged.
- When Gemma isn't connected, demo answers are labeled **prerecorded**. They are never passed off as live.
- The web app process never runs imported code. Demo checks run in an isolated `vm` context; a real repository's tests run only in the sandboxes below, and only when the server enables them.
- A proposed fix is **unverified** until it passes. Nothing is ever pushed to your repository.

---

## Screenshots

| | |
|---|---|
| ![Suspects](docs/screenshots/suspects.png) **Suspects** | ![Commit history](docs/screenshots/commit-history.png) **Commit history** |
| ![Compare commits](docs/screenshots/compare-commits.png) **Compare commits** | ![Impact map](docs/screenshots/impact-map.png) **Impact map** |
| ![Ask AI](docs/screenshots/ask-ai.png) **Ask AI** | ![Fix and verify](docs/screenshots/fix-and-verify.png) **Fix and verify** |
| ![Report](docs/screenshots/report.png) **Reports** | ![Repository health](docs/screenshots/repository-health.png) **Repository health** |

---

## Quick start

**Requirements:** Node.js ≥ 20, npm ≥ 10. Ollama (optional) for live Gemma.

```bash
git clone https://github.com/SwethaatGH/CausalCI.git && cd CausalCI
npm install
cp .env.example .env          # optional: add GITHUB_TOKEN, choose your Gemma model
npm run dev                   # API on :8787, web on :5173
```

Open **http://localhost:5173** and click **Try the demo**.

![Welcome screen](docs/screenshots/welcome.png)

| Script | Purpose |
|---|---|
| `npm run dev` | API (tsx watch) + web (Vite) together |
| `npm run build` | Typecheck + production build of the web app |
| `npm start` | Run the API (serve `apps/web/dist` with any static server) |
| `npm test` | All unit, integration and frontend tests |
| `npm run typecheck` | TypeScript across every workspace |
| `npm run lint` | ESLint |

### Environment variables

See [`.env.example`](.env.example). All secrets stay on the backend.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | API server |
| `DATABASE_PATH` | `./causalci.db` | SQLite file (relative to repo root) |
| `IMPORT_MODE` | `auto` | `git`: read history from a local partial clone (no rate limit, nothing truncated); `api`: GitHub REST API; `auto`: git when available |
| `CACHE_DIR` | `./.causalci-cache` | Where repository mirrors are kept |
| `GITHUB_TOKEN` | — | API mode: raises the GitHub limit from 60 to 5,000 requests/hour (git mode doesn't need it) |
| `BISECT_JOBS_ENABLED` | `false` | Let the server run repositories' tests in sandboxes (Confirm with tests, Run the checks); needs Docker or a worker |
| `AI_PROVIDER` | `ollama` | `ollama` or `gemini` |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | `gemma4` | Any installed Gemma 4 tag |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | — / `gemma-4-26b-a4b-it` | Gemma via the Gemini API |
| `MAX_GRAPH_FILES`, `MAX_PARSE_FILES_PER_COMMIT`, `MAX_FILE_BYTES`, `AI_TIMEOUT_MS` | see file | Analysis bounds |

### Connecting Gemma 4

**Option A — Ollama (local or Ollama cloud)**

```bash
ollama serve
ollama pull gemma4            # or a specific tag, e.g. gemma4:e4b
# set OLLAMA_MODEL to the exact tag shown by `ollama list`
```

**Option B — Gemini API**

```bash
AI_PROVIDER=gemini
GEMINI_API_KEY=...            # from Google AI Studio
GEMINI_MODEL=gemma-4-26b-a4b-it   # or gemma-4-31b-it; any Gemma model your key lists
```

Then open **Settings → Test connection**. The status check does more than list models: it runs a one-token generation. That catches failures a model listing misses, such as an exhausted cloud quota, and the UI shows the provider's exact error.

### Demo mode

The built-in demo is **`causalci-demo/orbit-checkout`**, a simulated TypeScript checkout service with 11 commits. Commit 6, *"Refactor discount stacking for seasonal promos"*, quietly removes three things:

- the coupon-expiry filter;
- the percentage validation;
- the 60% stacking cap.

Stacked coupons can then push totals negative. Several realistic decoys are mixed in: a cart-validation refactor that the heuristics flag but tests clear, a dependency bump, and an EU tax rounding change.

The demo needs neither GitHub nor Gemma. Its diffs are generated from file snapshots, so every patch, line number and score stays internally consistent. A deterministic harness bisects the history and confirms the regression. See [`demo/README.md`](demo/README.md).

### Deploying

`render.yaml` is a [Render](https://render.com) Blueprint for a single free web service: in Render choose **New → Blueprint** and pick this repository. In production the API also serves the built web app (`WEB_DIST_PATH`), and `PUBLIC_DEMO=true` makes settings and data clearing read-only so visitors cannot change or wipe the server. Free instances sleep when idle and have no persistent disk, so saved investigations reset on restart; the demo always works. Add `GEMINI_API_KEY` in the Render dashboard for live Gemma, knowing every visitor's requests count against your quota.

---

## Architecture

```text
causalci/
├── apps/
│   ├── web/        React 19 · Vite · Tailwind v4 · React Flow · Monaco · Recharts · TanStack Query · Zustand
│   ├── api/        Fastify · Octokit · better-sqlite3 · SSE · Gemma providers · bisect-job API · Prometheus metrics
│   ├── worker/     Queue consumer: clones, sandboxes, bisects; graceful drain, stale-job recovery, metrics
│   ├── cli/        `causalci` bisect · rank · select-tests · mine · eval · bench · signal
│   └── mcp/        MCP server for coding agents: rank_suspects · select_tests · find_culprit
├── packages/
│   ├── shared/     Domain types, Zod schemas (requests + AI output), terminology
│   ├── analysis/   Diff parsing; TypeScript type-checked resolution; Python / Go / Java via tree-sitter;
│   │               dependency graph, risk signals, learned ranker, binary / k-way / Bayesian bisection,
│   │               test selection, change-point detection, benchmark
│   └── runner/     Git adapter and partial-clone mirror, Docker / Kubernetes / local sandboxes, culprit hunt,
│                   SZZ mining, evaluation harness with bootstrap CIs, Redis reliable queue
├── deploy/         Helm chart (KEDA, gVisor RuntimeClass, NetworkPolicies), Terraform (GKE + GKE Sandbox),
│                   Argo CD app, Prometheus + Grafana
├── .github/        CI, find-culprit-on-red-main, signed image releases
└── docs/           Architecture, evaluation, threat model, deploy guide, ADRs, API reference
```

Pipeline: **Import → Fetch commits → Extract diffs → Parse code → Classify changes → Map dependencies → Score risk → Rank suspects → Ask Gemma (on demand) → Collect evidence → Report**.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · API: [docs/API.md](docs/API.md)

---

## Testing

```bash
npm test
```

112 tests across the workspaces:

- **`packages/analysis`, 67 tests:** diff and AST parsing, import resolution, risk scoring, ranking, the dependency graph, impact, evidence traceability, reports and patches; **type-checked JS/TS resolution** (path aliases, workspace packages, method calls, callbacks, interface dispatch); **Python, Go and Java** functions, imports and calls; binary, k-way and Bayesian bisection, the learned ranker, test selection and change-point detection.
- **`packages/runner`, 22 tests:** against real temporary git repositories. The culprit hunt with all three strategies; the **partial-clone mirror** (history, untruncated diffs, files, full tree); SZZ and revert mining; the evaluation harness; the sandbox isolation contract; the **workspace dependency cache** (the real install and test scripts); lockfile-based install commands; and **applying a proposed fix** before a run.
- **`apps/api`, 17 integration tests:** import, investigations, analysis, impact, comparison, the prerecorded fallback, AI output validation with **mocked inference**, fixes, reports, saved-investigation actions, sandboxed jobs (refused unless enabled, results written back as *confirmed by tests*), dismissed suspects and Prometheus metrics.
- **`apps/web`, 6 tests:** navigation, the repository form, the demo, shareable URL state, compare selection and the commit drawer.

---

## Scope and edges

What CausalCI covers, and where it deliberately stops:

- **Languages.** Function-level analysis for JS/TS (TypeScript compiler) and Python, Go and Java (tree-sitter). Other languages appear as files without relationships; nothing is invented.
- **Resolution.** JS/TS imports and calls are resolved by the TypeScript type checker: path aliases and `baseUrl`, workspace packages, method calls on typed instances, functions passed as callbacks, and calls through interfaces and overrides. Calls through `any`, computed `obj[name]()` and code outside the repository can't be followed. In Python, Go and Java, calls on untyped instances are linked only when the method name is unique, and labeled as a name match.
- **History.** The impact map uses the graph as it was at the selected commit, rebuilt from that commit's files and cached.
- **GitHub limits.** By default history comes from a local partial clone: no rate limit, and diffs and file trees are never truncated. In API mode, unchanged metadata is revalidated with ETags (not counted against the limit), truncated diffs are rebuilt from the raw files, and truncated trees are walked folder by folder.
- **Running tests.** The web app can run a repository's own tests (Confirm with tests, Run the checks), always in sandboxes and only when the server enables them; public demos keep it off.
- **Dependency cache.** Installs are cached per hash of every `package.json` and lockfile, and every `node_modules` (root and workspaces) is reused. npm, pnpm and Yarn are detected from the lockfile.
- **Evaluation.** 184 regressions across 9 repositories and 3 languages, with 95% bootstrap confidence intervals. Labels come from SZZ and reverts, which are noisy; see the threats to validity in [docs/EVALUATION.md](docs/EVALUATION.md).
- **False positives.** Pattern-based signals are hypotheses, not verdicts. Guards moved to another file in the same commit are recognized as refactors; a suspect can be marked *not the cause*; and **Confirm with tests** replaces the estimate with a test result.

## Roadmap

- Cilium FQDN egress policies so sandbox pods can reach only the git host and the package registry
- Postgres instead of SQLite so the API can run more than one replica
- Rust, Ruby and C# grammars (tree-sitter), and type information for Python (Pyright) and Go (`go/types`)
- Ranker evaluation on more repositories and languages
- Shared team investigations and comments

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)
