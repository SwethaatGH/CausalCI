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

Nine repositories in three languages, at the commits used: `sindresorhus/ky@3541888`, `axios/axios@4ee8d46f`, `expressjs/express@43fca52d`, `koajs/koa@7c6bfe7`, `sindresorhus/got@6b5aafc` (JavaScript/TypeScript); `psf/requests@3c7baaa0`, `pallets/flask@49943b5a` (Python); `spf13/cobra@adbc881`, `gin-gonic/gin@0f09c3a` (Go). **184 labelled regressions** fall inside the window.

Confidence intervals are 95% percentile bootstrap intervals (1,000 seeded resamples of the cases).

**Pooled over all 184 cases**

| Ranker | Top-1 | Top-3 (95% CI) | Top-5 | MRR |
|---|---:|---:|---:|---:|
| **learned** | **34.2%** | **65.8% (58.7–72.8%)** | **79.3%** | **0.539** |
| recency | 27.7% | 49.5% (42.4–56.5%) | 62.5% | 0.436 |
| size | 23.9% | 46.7% (39.7–53.3%) | 62.0% | 0.411 |
| heuristic | 20.7% | 38.0% (31.0–45.7%) | 52.7% | 0.361 |
| random | 5.0% | 15.0% | 25.0% | 0.180 |

The learned ranker's interval does not overlap the best baseline's, so the improvement is not noise.

**Per repository (learned top-3, held out, vs. the best other ranker on that repository)**

| Repository | Language | Cases | Learned top-3 (95% CI) | Best other ranker |
|---|---|---:|---:|---|
| ky | TS | 23 | 69.6% (47.8–87.0%) | size, 60.9% |
| axios | JS | 25 | 64.0% (44.0–80.0%) | recency, 48.0% |
| express | JS | 28 | 71.4% (53.6–89.3%) | recency, 67.9% |
| koa | JS | 27 | 66.7% (48.1–85.2%) | recency, 59.3% |
| got | TS | 14 | 42.9% (21.4–71.4%) | size, 42.9% |
| requests | Python | 22 | 63.6% (45.5–81.8%) | heuristic, 59.1% |
| flask | Python | 15 | 86.7% (66.7–100%) | recency, 80.0% |
| cobra | Go | 20 | 60.0% (35.0–80.0%) | size, 45.0% |
| gin | Go | 10 | 60.0% (30.0–90.0%) | recency, 70.0% |

The full per-ranker table is in [`eval/results.md`](eval/results.md); the trained weights are in [`eval/results.json`](eval/results.json).

### What this shows

- The hand-tuned heuristic beats random but loses to simple baselines. Learning the weights from mined data fixes that: the learned ranker is best on every pooled metric, and best or tied on top-3 in 8 of 9 held-out repositories (gin, with 10 cases, is the exception).
- It transfers across languages: each held-out Python or Go repository is ranked by a model trained mostly on other languages' history (for example, 6 of the 8 training repositories are JavaScript when cobra is held out), because the signals it relies on (recency, churn, docs-only changes) describe how projects change, not language syntax.
- The largest learned weights: recency (+1.78), churn (+1.26), docs-only (−0.98), number of files (+0.74), large diffs (+0.60) and dependency-manifest changes (−0.58).
- The shipped model (`packages/analysis/src/ranker-model.ts`) is trained on all 184 cases. It orders suspects and seeds the Bayesian search; the transparent signals remain the explanation.

### Threats to validity

- SZZ labels are noisy: refactors, or fixes that only add code, produce wrong or missing introducers. Reverts are cleaner but rarer.
- Nine repositories is still a modest sample; per-repository intervals are wide, so read small per-repository differences as ties. The pooled intervals are what support the headline claim.
- The 20-commit window is a modelling choice; most mined introducers are older and are skipped (462 of 646 labels).

### Reproduce

```bash
for r in sindresorhus/ky axios/axios expressjs/express koajs/koa sindresorhus/got psf/requests pallets/flask spf13/cobra gin-gonic/gin; do git clone https://github.com/$r; done
npx tsx apps/cli/src/index.ts eval --repo ky --repo axios --repo express --repo koa --repo got --repo requests --repo flask --repo cobra --repo gin --max-fixes 120 --window 20 --out results.json
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
