// Weights learned by `causalci eval` (logistic regression, all 76 mined regressions from
// sindresorhus/ky, axios/axios and expressjs/express). Regenerate with docs/EVALUATION.md.
import { FEATURE_NAMES, type LinearModel } from "./learn";

const WEIGHTS: Record<string, number> = {
  "bias": -1.871,
  "recency (1 = newest in window)": 1.475,
  "log churn": 1.066,
  "docs only": -1.045,
  "signal: import-change": 0.986,
  "signal: dependency-manifest": -0.95,
  "log files": 0.674,
  "signal: missing-tests": 0.521,
  "signal: test-modified": 0.493,
  "signal: control-flow": 0.442,
  "signal: large-diff": 0.432,
  "signal: configuration": 0.299,
  "heuristic score": 0.161,
  "signal: critical-path": 0.092,
  "signal: error-handling": -0.07,
  "signal: removed-validation": -0.011,
  "tests only": -0.002,
  "signal: function-modified": 0,
  "signal: high-fan-in": 0,
  "signal: symptom-match": 0
};

export const SHIPPED_RANKER: LinearModel = { featureNames: FEATURE_NAMES, weights: FEATURE_NAMES.map((n) => WEIGHTS[n] ?? 0) };
