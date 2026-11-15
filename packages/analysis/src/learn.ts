// A small learned ranker over the same transparent signals the heuristic uses, plus size and
// recency. Logistic regression trained with gradient descent; inspectable weights, no libraries.
import type { Commit, RiskAssessment, RiskSignalKind } from "@causalci/shared";
import { isDocsPath, isLockfile, isTestPath } from "./classify";
import { SIGNAL_WEIGHTS } from "./risk";

export const SIGNAL_KINDS = Object.keys(SIGNAL_WEIGHTS) as RiskSignalKind[];
export const FEATURE_NAMES = [
  "bias",
  "heuristic score",
  ...SIGNAL_KINDS.map((k) => `signal: ${k}`),
  "log churn",
  "log files",
  "recency (1 = newest in window)",
  "docs only",
  "tests only",
];

/** Feature vector for one commit at position `fromNewest` (0 = newest) in a window of `window` commits. */
export function commitFeatures(commit: Commit, a: RiskAssessment, fromNewest: number, window: number): number[] {
  const bySignal = new Map(a.signals.map((s) => [s.kind, s.weight]));
  const files = commit.files.filter((f) => !isLockfile(f.path));
  const churn = files.reduce((s, f) => s + f.additions + f.deletions, 0);
  return [
    1,
    a.score / 100,
    ...SIGNAL_KINDS.map((k) => (bySignal.get(k) ?? 0) / SIGNAL_WEIGHTS[k].max),
    Math.log1p(churn) / 8,
    Math.log1p(files.length) / 4,
    window > 1 ? 1 - fromNewest / (window - 1) : 1,
    files.length > 0 && files.every((f) => isDocsPath(f.path)) ? 1 : 0,
    files.length > 0 && files.every((f) => isTestPath(f.path)) ? 1 : 0,
  ];
}

export interface RankingGroup {
  /** One feature vector per candidate commit. */
  features: number[][];
  /** Index of the true culprit within `features`. */
  positive: number;
}

export interface LinearModel {
  weights: number[];
  featureNames: string[];
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const dot = (w: number[], x: number[]) => w.reduce((s, wi, i) => s + wi * x[i], 0);

/**
 * Pointwise logistic regression. Each group contributes one positive and many negatives, so the
 * classes are re-weighted to balance; L2 keeps the weights small and readable.
 */
export function trainRanker(groups: RankingGroup[], opts: { epochs?: number; lr?: number; l2?: number } = {}): LinearModel {
  const dim = groups[0]?.features[0]?.length ?? FEATURE_NAMES.length;
  const epochs = opts.epochs ?? 400;
  const lr = opts.lr ?? 0.5;
  const l2 = opts.l2 ?? 0.01;
  const w = new Array(dim).fill(0);
  const rows: { x: number[]; y: number; weight: number }[] = [];
  for (const g of groups) {
    const negatives = g.features.length - 1;
    g.features.forEach((x, i) => rows.push({ x, y: i === g.positive ? 1 : 0, weight: i === g.positive ? 1 : 1 / Math.max(1, negatives) }));
  }
  const total = rows.reduce((s, r) => s + r.weight, 0) || 1;
  for (let e = 0; e < epochs; e++) {
    const grad = new Array(dim).fill(0);
    for (const r of rows) {
      const err = (sigmoid(dot(w, r.x)) - r.y) * r.weight;
      for (let i = 0; i < dim; i++) grad[i] += err * r.x[i];
    }
    for (let i = 0; i < dim; i++) w[i] -= lr * (grad[i] / total + (i === 0 ? 0 : l2 * w[i]));
  }
  return { weights: w, featureNames: FEATURE_NAMES.slice(0, dim) };
}

export function scoreWith(model: LinearModel, features: number[]): number {
  return dot(model.weights, features);
}

/** 1-based rank of the positive in a group under the model (ties count against it). */
export function rankUnder(model: LinearModel, g: RankingGroup): number {
  const s = g.features.map((x) => scoreWith(model, x));
  const p = s[g.positive];
  return 1 + s.filter((v, i) => i !== g.positive && v >= p).length;
}
