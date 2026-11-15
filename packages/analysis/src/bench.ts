// Monte Carlo benchmark for the bisection strategies under flaky test suites.
// Everything here is simulated; results describe the stated assumptions, not a real codebase.
import { bayesianBisect, binaryBisect, kAryBisect, linearScan, priorFromScores, type Oracle, type SearchResult, type Verdict } from "./bisect";

/** Small, fast, seedable PRNG so benchmark runs are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Scenario {
  name: string;
  /** Candidate commits between last green and first red. */
  commits: number;
  /** P(good commit fails anyway). */
  falseFailRate: number;
  /** P(bad commit passes anyway). */
  missRate: number;
  /**
   * Quality of the heuristic prior: probability that the true culprit receives the top risk score.
   * Otherwise its score is drawn like any other commit's. 0 disables the prior.
   */
  priorHitRate: number;
}

export interface StrategyStats {
  strategy: string;
  accuracy: number;
  meanRuns: number;
  meanRounds: number;
  p95Runs: number;
}

export interface ScenarioResult {
  scenario: Scenario;
  trials: number;
  stats: StrategyStats[];
}

function flakyOracle(culprit: number, s: Scenario, rnd: () => number): Oracle {
  return async (i: number): Promise<Verdict> => {
    const bad = i >= culprit;
    const r = rnd();
    if (bad) return r < s.missRate ? "pass" : "fail";
    return r < s.falseFailRate ? "fail" : "pass";
  };
}

function syntheticScores(n: number, culprit: number, hitRate: number, rnd: () => number): number[] {
  const scores = Array.from({ length: n }, () => Math.round(rnd() * 60));
  if (rnd() < hitRate) scores[culprit] = Math.max(...scores) + 10 + Math.round(rnd() * 20);
  return scores;
}

const p95 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
};

export async function runScenario(s: Scenario, trials: number, seed = 1): Promise<ScenarioResult> {
  const rnd = mulberry32(seed);
  const named: { name: string; run: (culprit: number, scores: number[]) => Promise<SearchResult> }[] = [
    { name: "linear scan", run: (c) => linearScan(s.commits, flakyOracle(c, s, rnd)) },
    { name: "binary (git bisect)", run: (c) => binaryBisect(s.commits, flakyOracle(c, s, rnd)) },
    { name: "4-way parallel", run: (c) => kAryBisect(s.commits, 4, flakyOracle(c, s, rnd)) },
    { name: "bayesian", run: (c) => bayesianBisect(s.commits, flakyOracle(c, s, rnd), { falseFailRate: Math.max(s.falseFailRate, 0.01), missRate: Math.max(s.missRate, 0.01) }) },
  ];
  if (s.priorHitRate > 0)
    named.push({
      name: "bayesian + risk prior",
      run: (c, scores) =>
        bayesianBisect(s.commits, flakyOracle(c, s, rnd), { prior: priorFromScores(scores, 2), falseFailRate: Math.max(s.falseFailRate, 0.01), missRate: Math.max(s.missRate, 0.01) }),
    });

  const acc = named.map(() => ({ hits: 0, runs: [] as number[], rounds: [] as number[] }));
  for (let t = 0; t < trials; t++) {
    const culprit = Math.floor(rnd() * s.commits);
    const scores = syntheticScores(s.commits, culprit, s.priorHitRate, rnd);
    for (let k = 0; k < named.length; k++) {
      const r = await named[k].run(culprit, scores);
      if (r.culprit === culprit) acc[k].hits++;
      acc[k].runs.push(r.runs);
      acc[k].rounds.push(r.rounds);
    }
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    scenario: s,
    trials,
    stats: named.map((n, k) => ({
      strategy: n.name,
      accuracy: acc[k].hits / trials,
      meanRuns: mean(acc[k].runs),
      meanRounds: mean(acc[k].rounds),
      p95Runs: p95(acc[k].runs),
    })),
  };
}

export const DEFAULT_SCENARIOS: Scenario[] = [
  { name: "deterministic suite, 64 commits", commits: 64, falseFailRate: 0, missRate: 0, priorHitRate: 0 },
  { name: "flaky suite (5% false fail, 10% miss), 64 commits", commits: 64, falseFailRate: 0.05, missRate: 0.1, priorHitRate: 0 },
  { name: "flaky suite + heuristic prior (culprit top-scored 50% of the time), 64 commits", commits: 64, falseFailRate: 0.05, missRate: 0.1, priorHitRate: 0.5 },
  { name: "deterministic suite, 512 commits", commits: 512, falseFailRate: 0, missRate: 0, priorHitRate: 0 },
];

export function benchToMarkdown(results: ScenarioResult[]): string {
  const out: string[] = ["# Bisection benchmark (simulated)", "", "Monte Carlo simulation with a seeded PRNG. Flake rates and prior quality are assumptions stated per scenario.", ""];
  for (const r of results) {
    out.push(`## ${r.scenario.name}`, "", `${r.trials} trials.`, "", "| Strategy | Accuracy | Mean runs | p95 runs | Mean rounds |", "|---|---:|---:|---:|---:|");
    for (const s of r.stats) out.push(`| ${s.strategy} | ${(s.accuracy * 100).toFixed(1)}% | ${s.meanRuns.toFixed(1)} | ${s.p95Runs} | ${s.meanRounds.toFixed(1)} |`);
    out.push("");
  }
  return out.join("\n");
}
