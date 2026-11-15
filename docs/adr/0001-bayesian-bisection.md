# 1. Bayesian bisection as the default search

Status: accepted

## Context

`git bisect` assumes every test run is truthful. One flaky failure on a good commit sends the search into the wrong half for good. CI suites are routinely flaky, and the simulation in `docs/EVALUATION.md` shows binary search picking the right commit only 61% of the time at a 5% false-failure and 10% miss rate.

## Decision

Model each run as noisy evidence: P(fail | bad) = 1 − miss and P(fail | good) = ε. Keep a posterior over "which commit is first-bad". Test where the expected information gain is highest, which the prefix-sum identity makes O(n) per step, and stop at 95% posterior confidence or a run budget. Seed the prior with the learned ranker's scores, with every commit kept above zero.

## Consequences

- 97.9% accuracy on the simulated flaky suite, for about 4.6 more runs than binary search on average.
- On a deterministic suite it costs about the same as binary search (6.3 vs. 6.0 runs at 64 commits).
- The flake rates are parameters. Wrong values degrade gracefully; they only shift how often it re-tests.
- `binary` and `k-ary` remain available for suites known to be deterministic.
