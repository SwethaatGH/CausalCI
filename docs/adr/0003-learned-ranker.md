# 3. Rank suspects with a learned model, explain with heuristics

Status: accepted

## Context

The original hand-weighted risk score was evaluated against 76 regressions mined with SZZ and reverts from three open-source repositories. It beat random ordering (38% vs. 15% top-3) but lost to "largest diff first" and "newest first" on two of the three repositories.

## Decision

Train a logistic regression on the same signals plus churn, file count, recency and docs-only/tests-only flags. Validate it leave-one-repository-out. Ship the weights in `ranker-model.ts`. The model orders suspects and seeds the Bayesian prior; the heuristic signals remain the evidence shown to users, because a weight vector is not an explanation.

## Consequences

- Pooled top-3 accuracy rises to 65.8% (95% CI 58.7–72.8%) vs. 49.5% (42.4–56.5%) for the best baseline, across 184 regressions in 9 repositories and 3 languages, each scored by a model that never trained on that repository. (The first evaluation, on 76 cases from 3 JavaScript repositories, gave 64.5% vs. 44.7%.)
- The model is plain numbers in source control: reviewable, diffable and reproducible from `causalci eval`.
- Retraining on more repositories is one command. The evaluation harness is the regression test for ranking changes.
