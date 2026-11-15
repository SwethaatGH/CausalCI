# Bisection benchmark (simulated)

Monte Carlo simulation with a seeded PRNG. Flake rates and prior quality are assumptions stated per scenario.

## deterministic suite, 64 commits

1000 trials.

| Strategy | Accuracy | Mean runs | p95 runs | Mean rounds |
|---|---:|---:|---:|---:|
| linear scan | 100.0% | 32.7 | 61 | 32.7 |
| binary (git bisect) | 100.0% | 6.0 | 6 | 6.0 |
| 4-way parallel | 100.0% | 9.7 | 10 | 3.0 |
| bayesian | 100.0% | 6.3 | 7 | 6.3 |

## flaky suite (5% false fail, 10% miss), 64 commits

1000 trials.

| Strategy | Accuracy | Mean runs | p95 runs | Mean rounds |
|---|---:|---:|---:|---:|
| linear scan | 26.9% | 14.3 | 38 | 14.3 |
| binary (git bisect) | 61.0% | 6.0 | 6 | 6.0 |
| 4-way parallel | 62.6% | 9.7 | 10 | 3.0 |
| bayesian | 97.9% | 10.6 | 17 | 10.6 |

## flaky suite + heuristic prior (culprit top-scored 50% of the time), 64 commits

1000 trials.

| Strategy | Accuracy | Mean runs | p95 runs | Mean rounds |
|---|---:|---:|---:|---:|
| linear scan | 25.9% | 14.0 | 40 | 14.0 |
| binary (git bisect) | 63.8% | 6.0 | 6 | 6.0 |
| 4-way parallel | 62.1% | 9.7 | 10 | 3.0 |
| bayesian | 97.3% | 10.7 | 17 | 10.7 |
| bayesian + risk prior | 97.3% | 9.9 | 17 | 9.9 |

## deterministic suite, 512 commits

1000 trials.

| Strategy | Accuracy | Mean runs | p95 runs | Mean rounds |
|---|---:|---:|---:|---:|
| linear scan | 100.0% | 255.0 | 482 | 255.0 |
| binary (git bisect) | 100.0% | 9.0 | 9 | 9.0 |
| 4-way parallel | 100.0% | 15.1 | 16 | 4.0 |
| bayesian | 100.0% | 9.4 | 10 | 9.4 |

