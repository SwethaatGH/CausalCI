// Weights learned by `causalci eval` (logistic regression, all 184 mined regressions from
// 9 repositories in JavaScript, Python and Go). Regenerate with docs/EVALUATION.md.
import { FEATURE_NAMES, type LinearModel } from "./learn";

const WEIGHTS: Record<string, number> = {
  "bias": -2.022,
  "recency (1 = newest in window)": 1.783,
  "log churn": 1.258,
  "docs only": -0.982,
  "log files": 0.737,
  "signal: large-diff": 0.601,
  "signal: dependency-manifest": -0.581,
  "signal: control-flow": 0.48,
  "signal: import-change": 0.465,
  "signal: missing-tests": 0.434,
  "tests only": -0.254,
  "signal: critical-path": 0.221,
  "signal: error-handling": 0.208,
  "heuristic score": 0.206,
  "signal: test-modified": 0.15,
  "signal: configuration": 0.083,
  "signal: removed-validation": 0.024,
  "signal: function-modified": 0,
  "signal: high-fan-in": 0,
  "signal: symptom-match": 0
};

export const SHIPPED_RANKER: LinearModel = { featureNames: FEATURE_NAMES, weights: FEATURE_NAMES.map((n) => WEIGHTS[n] ?? 0) };
