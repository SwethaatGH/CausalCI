# Evaluation

Two questions, measured separately:

1. **Ranking.** Before running anything, how often is the real culprit near the top of the suspect list?
2. **Search.** Once tests run, how many runs does each bisection strategy need, and how often is it right when the suite is flaky?

## 1. Ranking on real regressions

### Ground truth

Labels come from each repository's own history (`causalci mine`):

- **Reverts.** `Revert "…"` commits whose body says `This reverts commit <sha>` name the bad commit directly.
- **SZZ** (Śliwerski, Zimmermann & Zeller, 2005). For every commit whose subject looks like a bug fix, the lines it deletes or modifies are blamed on its parent (`git blame -w`, comment and blank lines ignored). The commit that last touched most of those lines is the bug introducer. A label is kept only when one commit holds at least half of the blamed lines.

### Protocol

For each label, the 20 first-parent commits that landed before the fix form the candidate window, the same shape as "something broke since the last green build". Cases whose introducer is older than the window are skipped. Each ranker orders the window, and the introducer's position is recorded.

| Ranker | What it does |
|---|---|
| heuristic | Hand-weighted risk signals (`packages/analysis/src/risk.ts`) |
| learned | Logistic regression over the same signals plus churn, file count, recency and docs-only/tests-only flags (`packages/analysis/src/learn.ts`) |
| recency | Newest first |
| size | Largest diff first |
| random | Exact expectation of a uniform shuffle |

The learned ranker is scored with **leave-one-repository-out** cross-validation: for each repository it is trained on the other two and tested on this one, so it is never tested on a repository it trained on.

### Results

Repositories at the commits used: `sindresorhus/ky@3541888`, `axios/axios@4ee8d46f`, `expressjs/express@43fca52d`. 76 labelled regressions fall inside the window (23 + 25 + 28).

**Pooled over all 76 cases**

| Ranker | Top-1 | Top-3 | Top-5 | MRR |
|---|---:|---:|---:|---:|
| **learned** | **27.6%** | **64.5%** | **77.6%** | **0.486** |
| recency | 26.3% | 44.7% | 53.9% | 0.402 |
| size | 23.7% | 46.1% | 60.5% | 0.407 |
| heuristic | 23.7% | 38.2% | 46.1% | 0.373 |
| random | 5.0% | 15.0% | 25.0% | 0.180 |

**Per repository (learned vs. the best baseline on that repository)**

| Repository | Cases | Learned top-3 | Best baseline top-3 |
|---|---:|---:|---|
| ky | 23 | 69.6% | size, 60.9% |
| axios | 25 | 64.0% | heuristic / recency, 48.0% |
| express | 28 | 60.7% | recency, 67.9% |

The full per-ranker table and the trained weights are in [`eval/results.json`](eval/results.json).

### What this shows

- The hand-tuned heuristic beats random but loses to simple baselines on two of three repositories. Learning the weights from mined data fixes that: the learned ranker is the best on every pooled metric and on top-3 in two of three held-out repositories.
- The largest learned weights are recency (+1.48), churn (+1.07), docs-only (−1.05), import changes (+0.99) and dependency-manifest changes (−0.95). Regressions cluster in recent, larger code changes, and lockfile bumps are rarely the culprit in these projects.
- The shipped model (`packages/analysis/src/ranker-model.ts`) is trained on all 76 cases. It orders `causalci rank` and seeds the Bayesian search; the heuristic signals stay as the human-readable explanation of each suspect.

### Threats to validity

- SZZ labels are noisy: refactors, or fixes that only add code, produce wrong or missing introducers. Reverts are cleaner but rarer.
- Three JavaScript repositories and 76 cases is a small sample. Confidence intervals are wide, so read differences of a few points as ties.
- The 20-commit window is a modelling choice; most mined introducers are older and are skipped (178 of 254 labels).

### Reproduce

```bash
git clone https://github.com/sindresorhus/ky && git clone https://github.com/axios/axios && git clone https://github.com/expressjs/express
npx tsx apps/cli/src/index.ts eval --repo ky --repo axios --repo express --max-fixes 120 --window 20 --out results.json
```

Mined labels are cached next to each clone (`<repo>.causalci-labels.json`), so later runs skip mining.

## 2. Search under flaky tests (simulated)

Real CI suites are flaky, and plain `git bisect` trusts every run. `causalci bench` runs a seeded Monte Carlo simulation of each strategy against suites with stated flake rates. These numbers describe the stated assumptions, not a real codebase. Full table: [`eval/bench.md`](eval/bench.md) (1,000 trials per scenario).

**Flaky suite (5% false failures, 10% missed failures), 64 candidate commits**

| Strategy | Accuracy | Mean runs | Mean rounds |
|---|---:|---:|---:|
| linear scan | 26.9% | 14.3 | 14.3 |
| binary (`git bisect`) | 61.0% | 6.0 | 6.0 |
| 4-way parallel | 62.6% | 9.7 | 3.0 |
| **Bayesian** | **97.9%** | 10.6 | 10.6 |

**Deterministic suite**

| Commits | Binary rounds | 4-way parallel rounds |
|---:|---:|---:|
| 64 | 6.0 | 3.0 |
| 512 | 9.0 | 4.0 |

- **Bayesian search** keeps a posterior over every candidate and tests wherever the expected information gain is highest, re-testing a commit when that is the most informative move. It stops at 95% confidence instead of trusting single runs. On the flaky suite it is right 97.9% of the time against 61.0% for `git bisect`, for about 4.6 extra runs.
- **k-way parallel search** halves wall-clock rounds at 64 commits and cuts them from 9 to 4 at 512, at the cost of more total runs. Use it when runners are cheap and time is not.
- **A ranking prior** (when the culprit is top-scored half the time) trims Bayesian runs from 10.7 to 9.9 at equal accuracy. A wrong prior never causes a wrong answer, because every commit keeps non-zero prior mass.
