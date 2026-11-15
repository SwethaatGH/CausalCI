// Offline evaluation of the suspect ranker against mined ground truth.
// For each labelled regression, take the W commits that landed before its fix (a realistic
// "something broke since the last good build" window), rank them, and see where the real
// introducer lands. Baselines put the numbers in context; a learned ranker is scored with
// leave-one-repository-out cross-validation so it is never tested on a repo it trained on.
import { basename } from "node:path";
import { assessCommit, commitFeatures, rankUnder, trainRanker, type LinearModel, type RankingGroup } from "@causalci/analysis";
import type { Commit } from "@causalci/shared";
import { loadCommit, recentCommits } from "./git";
import type { RegressionLabel } from "./szz";

export type Ranker = "heuristic" | "learned" | "recency" | "size" | "random";
export const RANKERS: Ranker[] = ["heuristic", "learned", "recency", "size", "random"];

export interface EvalCase {
  label: RegressionLabel;
  window: number;
  ranks: Partial<Record<Ranker, number>>;
  group: RankingGroup;
}

export interface Metrics {
  top1: number;
  top3: number;
  top5: number;
  mrr: number;
}

export interface EvalSummary {
  repo: string;
  cases: number;
  skipped: number;
  window: number;
  metrics: Partial<Record<Ranker, Metrics>>;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const harmonic = (n: number) => {
  let h = 0;
  for (let i = 1; i <= n; i++) h += 1 / i;
  return h;
};

function metricsFromRanks(ranks: number[]): Metrics {
  return { top1: avg(ranks.map((k) => +(k <= 1))), top3: avg(ranks.map((k) => +(k <= 3))), top5: avg(ranks.map((k) => +(k <= 5))), mrr: avg(ranks.map((k) => 1 / k)) };
}

/** Exact expectation for a uniformly random order (not a sampled run). */
function randomMetrics(cases: EvalCase[]): Metrics {
  return {
    top1: avg(cases.map((c) => Math.min(1, 1 / c.window))),
    top3: avg(cases.map((c) => Math.min(1, 3 / c.window))),
    top5: avg(cases.map((c) => Math.min(1, 5 / c.window))),
    mrr: avg(cases.map((c) => harmonic(c.window) / c.window)),
  };
}

export function summarize(repo: string, cases: EvalCase[], skipped: number, window: number): EvalSummary {
  const metrics: EvalSummary["metrics"] = {};
  for (const r of RANKERS) {
    if (r === "random") metrics.random = randomMetrics(cases);
    else if (cases.every((c) => c.ranks[r] !== undefined)) metrics[r] = metricsFromRanks(cases.map((c) => c.ranks[r]!));
  }
  return { repo, cases: cases.length, skipped, window, metrics };
}

export async function evaluateLabels(repo: string, labels: RegressionLabel[], opts: { window?: number; onCase?: (c: EvalCase) => void } = {}): Promise<{ summary: EvalSummary; cases: EvalCase[] }> {
  const W = opts.window ?? 20;
  const cache = new Map<string, Commit>();
  const load = async (sha: string) => {
    if (!cache.has(sha)) cache.set(sha, await loadCommit(repo, sha));
    return cache.get(sha)!;
  };
  const cases: EvalCase[] = [];
  let skipped = 0;
  for (const label of labels) {
    const fix = await load(label.fixSha);
    const shas = fix.parents.length ? await recentCommits(repo, fix.parents[0], W) : [];
    if (!shas.includes(label.introducingSha)) {
      skipped++; // the introducer landed long before the fix; outside a realistic bisect window
      continue;
    }
    const commits = await Promise.all(shas.map(load));
    const assessments = commits.map((c) => assessCommit(c));
    const n = commits.length;
    const order = (key: (i: number) => number) => [...commits.keys()].sort((a, b) => key(b) - key(a) || b - a);
    const rankIn = (sorted: number[]) => sorted.indexOf(shas.indexOf(label.introducingSha)) + 1;
    const c: EvalCase = {
      label,
      window: n,
      ranks: {
        heuristic: rankIn(order((i) => assessments[i].score)),
        recency: rankIn(order((i) => i)),
        size: rankIn(order((i) => commits[i].stats?.total ?? 0)),
      },
      group: { features: commits.map((cm, i) => commitFeatures(cm, assessments[i], n - 1 - i, n)), positive: shas.indexOf(label.introducingSha) },
    };
    cases.push(c);
    opts.onCase?.(c);
  }
  return { summary: summarize(basename(repo), cases, skipped, W), cases };
}

/**
 * Leave-one-repository-out: for each repository, train on all the others and rank its cases.
 * Fills `ranks.learned` in place and returns the model trained on everything (for inspection).
 */
export function crossValidateLearned(byRepo: { repo: string; cases: EvalCase[] }[]): LinearModel | null {
  const usable = byRepo.filter((r) => r.cases.length);
  if (usable.length < 2) return null;
  for (const held of usable) {
    const train = usable.filter((r) => r !== held).flatMap((r) => r.cases.map((c) => c.group));
    const model = trainRanker(train);
    for (const c of held.cases) c.ranks.learned = rankUnder(model, c.group);
  }
  return trainRanker(usable.flatMap((r) => r.cases.map((c) => c.group)));
}

export function evalToMarkdown(summaries: EvalSummary[]): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const out = ["| Repository | Cases | Ranker | Top-1 | Top-3 | Top-5 | MRR |", "|---|---:|---|---:|---:|---:|---:|"];
  for (const s of summaries)
    for (const r of RANKERS) {
      const m = s.metrics[r];
      if (m) out.push(`| ${s.repo} | ${s.cases} | ${r} | ${pct(m.top1)} | ${pct(m.top3)} | ${pct(m.top5)} | ${m.mrr.toFixed(3)} |`);
    }
  return out.join("\n");
}

/** Pools cases across repositories into one summary row per ranker. */
export function pooledSummary(byRepo: { repo: string; cases: EvalCase[]; skipped: number }[], window: number): EvalSummary {
  return summarize(`all (${byRepo.length} repos)`, byRepo.flatMap((r) => r.cases), byRepo.reduce((s, r) => s + r.skipped, 0), window);
}
