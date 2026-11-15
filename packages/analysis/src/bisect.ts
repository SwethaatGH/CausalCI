// Search strategies for the first bad commit in an ordered range.
//
// Convention: candidates are indexed 0..n-1 in chronological order, all strictly after the last
// known-good commit. Index n-1 is the known-bad commit. The culprit is the first index whose
// commit fails; every later commit is assumed to fail too (the regression persists).

export type Verdict = "pass" | "fail";
/** Runs the test suite at candidate `index`. May be called more than once for the same index. */
export type Oracle = (index: number) => Promise<Verdict>;

export interface BisectStep {
  index: number;
  verdict: Verdict;
  round: number;
}

export interface SearchResult {
  strategy: "linear" | "binary" | "k-ary" | "bayesian";
  culprit: number;
  /** Total test-suite executions. */
  runs: number;
  /** Sequential rounds; runs inside one round execute in parallel. Proxy for wall-clock time. */
  rounds: number;
  steps: BisectStep[];
  /** Posterior probability of the reported culprit (Bayesian only; 1 for deterministic strategies). */
  confidence: number;
  posterior?: number[];
}

function assertRange(n: number) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`candidate count must be a positive integer, got ${n}`);
}

/** Baseline: test commits oldest-first until one fails. */
export async function linearScan(n: number, oracle: Oracle): Promise<SearchResult> {
  assertRange(n);
  const steps: BisectStep[] = [];
  for (let i = 0; i < n - 1; i++) {
    const verdict = await oracle(i);
    steps.push({ index: i, verdict, round: steps.length + 1 });
    if (verdict === "fail") return { strategy: "linear", culprit: i, runs: steps.length, rounds: steps.length, steps, confidence: 1 };
  }
  return { strategy: "linear", culprit: n - 1, runs: steps.length, rounds: steps.length, steps, confidence: 1 };
}

/** Classic bisection, as `git bisect run` does it: ⌈log₂ n⌉ runs. */
export async function binaryBisect(n: number, oracle: Oracle): Promise<SearchResult> {
  assertRange(n);
  let lo = 0;
  let hi = n - 1;
  const steps: BisectStep[] = [];
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const verdict = await oracle(mid);
    steps.push({ index: mid, verdict, round: steps.length + 1 });
    if (verdict === "fail") hi = mid;
    else lo = mid + 1;
  }
  return { strategy: "binary", culprit: lo, runs: steps.length, rounds: steps.length, steps, confidence: 1 };
}

/** Up to k distinct, evenly spaced probe points in [lo, hi). */
export function probePoints(lo: number, hi: number, k: number): number[] {
  const width = hi - lo;
  if (width <= 0) return [];
  const count = Math.min(k, width);
  const pts = new Set<number>();
  for (let j = 1; j <= count; j++) pts.add(lo + Math.floor((j * width) / (count + 1)));
  return [...pts].sort((a, b) => a - b);
}

/**
 * Parallel k-ary bisection: each round tests k commits concurrently and keeps the one sub-interval
 * that must contain the culprit, so rounds drop from log₂(n) to about log₍ₖ₊₁₎(n).
 */
export async function kAryBisect(n: number, k: number, oracle: Oracle): Promise<SearchResult> {
  assertRange(n);
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`k must be a positive integer, got ${k}`);
  let lo = 0;
  let hi = n - 1;
  const steps: BisectStep[] = [];
  let round = 0;
  while (lo < hi) {
    round++;
    const pts = probePoints(lo, hi, k);
    const verdicts = await Promise.all(pts.map((p) => oracle(p)));
    pts.forEach((p, i) => steps.push({ index: p, verdict: verdicts[i], round }));
    const firstFail = verdicts.indexOf("fail");
    if (firstFail === -1) lo = pts[pts.length - 1] + 1;
    else {
      hi = pts[firstFail];
      if (firstFail > 0) lo = pts[firstFail - 1] + 1;
    }
  }
  return { strategy: "k-ary", culprit: lo, runs: steps.length, rounds: round, steps, confidence: 1 };
}

export interface BayesOptions {
  /** P(culprit = i) before any test; defaults to uniform. Need not be normalized. */
  prior?: number[];
  /** P(a good commit's suite fails anyway): flaky false alarm. */
  falseFailRate?: number;
  /** P(a bad commit's suite passes anyway): flaky miss. */
  missRate?: number;
  /** Stop once the most likely culprit reaches this posterior probability. */
  confidence?: number;
  maxRuns?: number;
  /** Probes per round (run in parallel); the top-k most informative points are chosen. */
  parallel?: number;
}

const H = (p: number) => (p <= 0 || p >= 1 ? 0 : -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p)));

/**
 * Expected information (bits) a test at each index gives about the culprit.
 * The outcome depends on the culprit only through "is commit j bad" (culprit ≤ j), so the
 * mutual information is H(outcome) − E[H(outcome | bad_j)], computable in O(n) with a prefix sum.
 */
export function informationGain(posterior: number[], falseFailRate: number, missRate: number): number[] {
  const out = new Array<number>(posterior.length);
  let cdf = 0;
  for (let j = 0; j < posterior.length; j++) {
    cdf += posterior[j];
    const c = Math.min(1, cdf);
    const pFail = c * (1 - missRate) + (1 - c) * falseFailRate;
    out[j] = H(pFail) - (c * H(missRate) + (1 - c) * H(falseFailRate));
  }
  return out;
}

/** Bayes update of the culprit posterior after observing `verdict` at index j. */
export function updatePosterior(posterior: number[], j: number, verdict: Verdict, falseFailRate: number, missRate: number): number[] {
  const next = posterior.map((p, i) => {
    const bad = i <= j;
    const likelihood = verdict === "fail" ? (bad ? 1 - missRate : falseFailRate) : bad ? missRate : 1 - falseFailRate;
    return p * likelihood;
  });
  const z = next.reduce((s, x) => s + x, 0);
  if (z === 0) return posterior.map(() => 1 / posterior.length);
  return next.map((x) => x / z);
}

export function normalize(weights: number[]): number[] {
  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const z = clean.reduce((s, x) => s + x, 0);
  return z === 0 ? weights.map(() => 1 / weights.length) : clean.map((x) => x / z);
}

/**
 * Turns heuristic risk scores (0–100) into a prior. `strength` controls how much the heuristics
 * are trusted: 0 = uniform, larger = sharper. Every commit keeps non-zero mass, so a wrong
 * heuristic only costs extra runs instead of a wrong answer.
 */
export function priorFromScores(scores: number[], strength = 1): number[] {
  return normalize(scores.map((s) => 1 + strength * Math.max(0, s) / 10));
}

/**
 * Flaky-aware Bayesian bisection. Keeps a probability for every candidate being the culprit,
 * always tests where the expected information gain is highest (re-testing the same commit when
 * that is most informative), and stops at the requested confidence instead of trusting any
 * single run.
 */
export async function bayesianBisect(n: number, oracle: Oracle, opts: BayesOptions = {}): Promise<SearchResult> {
  assertRange(n);
  const eps = opts.falseFailRate ?? 0.05;
  const miss = opts.missRate ?? 0.1;
  const target = opts.confidence ?? 0.95;
  const maxRuns = opts.maxRuns ?? Math.max(16, Math.ceil(Math.log2(n + 1)) * 6);
  const parallel = Math.max(1, opts.parallel ?? 1);
  if (opts.prior && opts.prior.length !== n) throw new RangeError(`prior has ${opts.prior.length} entries for ${n} candidates`);
  if (!(eps >= 0 && eps < 0.5 && miss >= 0 && miss < 0.5)) throw new RangeError("flake rates must be in [0, 0.5)");

  let posterior = opts.prior ? normalize(opts.prior) : new Array(n).fill(1 / n);
  const steps: BisectStep[] = [];
  let round = 0;
  const best = () => posterior.reduce((bi, p, i, arr) => (p > arr[bi] ? i : bi), 0);

  while (posterior[best()] < target && steps.length < maxRuns && n > 1) {
    round++;
    const gain = informationGain(posterior, eps, miss);
    // The known-bad endpoint is never worth testing; it carries no information under the model.
    const order = gain
      .map((g, i) => ({ g, i }))
      .filter((x) => x.i < n - 1)
      .sort((a, b) => b.g - a.g || a.i - b.i);
    const batch = order.slice(0, Math.min(parallel, maxRuns - steps.length)).map((x) => x.i);
    if (!batch.length || gain[batch[0]] <= 1e-9) break;
    const verdicts = await Promise.all(batch.map((j) => oracle(j)));
    batch.forEach((j, idx) => {
      steps.push({ index: j, verdict: verdicts[idx], round });
      posterior = updatePosterior(posterior, j, verdicts[idx], eps, miss);
    });
  }
  const culprit = best();
  return { strategy: "bayesian", culprit, runs: steps.length, rounds: round, steps, confidence: posterior[culprit], posterior };
}
