# 3. Rank suspects with a learned model, explain with heuristics

Status: accepted

## Context

The original hand-weighted risk score was evaluated against 76 regressions mined with SZZ and reverts from three open-source repositories. It beat random ordering (38% vs. 15% top-3) but lost to "largest diff first" and "newest first" on two of the three repositories.

## Decision

Train a logistic regression on the same signals plus churn, file count, recency and docs-only/tests-only flags. Validate it leave-one-repository-out. Ship the weights in `ranker-model.ts`. The model orders suspects and seeds the Bayesian prior; the heuristic signals remain the evidence shown to users, because a weight vector is not an explanation.

## Consequences

- Pooled top-3 accuracy rises to 64.5% (vs. 44.7% for the best baseline) on repositories the model never trained on.
- The model is plain numbers in source control: reviewable, diffable and reproducible from `causalci eval`.
- Retraining on more repositories is one command. The evaluation harness is the regression test for ranking changes.
