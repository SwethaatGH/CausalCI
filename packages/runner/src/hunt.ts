// The end-to-end culprit hunt: rank a commit range, then bisect it with a real test runner.
import type { Commit } from "@causalci/shared";
import {
  SHIPPED_RANKER,
  assessCommit,
  bayesianBisect,
  binaryBisect,
  commitFeatures,
  firstLine,
  kAryBisect,
  normalize,
  scoreWith,
  type SearchResult,
  type Verdict,
} from "@causalci/analysis";
import { commitRange, loadCommit } from "./git";
import type { RunResult, TestRunner } from "./sandbox";

export type Strategy = "binary" | "k-ary" | "bayesian";

export interface HuntOptions {
  repo: string;
  good: string;
  bad: string;
  runner: TestRunner;
  strategy?: Strategy;
  /** Parallel test runs per round (k-ary and bayesian). */
  parallel?: number;
  /** Seed the Bayesian prior with the learned ranker's scores. */
  usePrior?: boolean;
  falseFailRate?: number;
  missRate?: number;
  confidence?: number;
  maxRuns?: number;
  onRun?: (r: RunResult, index: number) => void;
}

export interface RankedCommit {
  sha: string;
  shortSha: string;
  title: string;
  /** Heuristic risk score (0–100), explained by `topSignals`. */
  score: number;
  /** Learned ranker's probability-like score; this is what orders the list. */
  likelihood: number;
  topSignals: string[];
}

export interface HuntResult {
  range: { good: string; bad: string; commits: number };
  strategy: Strategy;
  culprit: RankedCommit;
  confidence: number;
  runs: number;
  rounds: number;
  /** Rank the learned ranker gave the confirmed culprit before any test ran (1 = top). */
  heuristicRank: number;
  ranking: RankedCommit[];
  testRuns: (RunResult & { index: number })[];
  search: SearchResult;
}

/**
 * Orders a range by the learned ranker (trained on mined regressions, see docs/EVALUATION.md) and
 * keeps the heuristic signals as the human-readable explanation. `prior` is the learned scores
 * turned into a probability distribution, in chronological order, for the Bayesian search.
 */
export async function rankRange(repo: string, shas: string[]): Promise<{ commits: Commit[]; ranking: RankedCommit[]; prior: number[] }> {
  const commits: Commit[] = [];
  for (const sha of shas) commits.push(await loadCommit(repo, sha));
  const n = commits.length;
  const scored = commits.map((c, i) => {
    const a = assessCommit(c);
    const z = scoreWith(SHIPPED_RANKER, commitFeatures(c, a, n - 1 - i, n));
    return { c, a, likelihood: 1 / (1 + Math.exp(-z)) };
  });
  const prior = normalize(scored.map((x) => x.likelihood));
  const ranking = scored
    .map(({ c, a, likelihood }) => ({ sha: c.sha, shortSha: c.shortSha, title: firstLine(c.message), score: a.score, likelihood, topSignals: a.signals.slice(0, 3).map((s) => s.label) }))
    .sort((x, y) => y.likelihood - x.likelihood);
  return { commits, ranking, prior };
}

/** Finds the first commit in (good, bad] whose test command fails. */
export async function huntCulprit(o: HuntOptions): Promise<HuntResult> {
  const shas = await commitRange(o.repo, o.good, o.bad);
  if (!shas.length) throw new Error(`No commits between ${o.good} and ${o.bad}`);
  const { ranking, prior } = await rankRange(o.repo, shas);
  const strategy = o.strategy ?? "bayesian";
  const testRuns: (RunResult & { index: number })[] = [];
  const oracle = async (i: number): Promise<Verdict> => {
    const r = await o.runner.run(shas[i]);
    testRuns.push({ ...r, index: i });
    o.onRun?.(r, i);
    return r.verdict;
  };

  const n = shas.length;
  const search =
    strategy === "binary"
      ? await binaryBisect(n, oracle)
      : strategy === "k-ary"
        ? await kAryBisect(n, Math.max(1, o.parallel ?? 4), oracle)
        : await bayesianBisect(n, oracle, {
            prior: o.usePrior === false ? undefined : prior,
            falseFailRate: o.falseFailRate,
            missRate: o.missRate,
            confidence: o.confidence,
            maxRuns: o.maxRuns,
            parallel: o.parallel,
          });

  const culpritSha = shas[search.culprit];
  const culprit = ranking.find((r) => r.sha === culpritSha)!;
  return {
    range: { good: o.good, bad: o.bad, commits: n },
    strategy,
    culprit,
    confidence: search.confidence,
    runs: search.runs,
    rounds: search.rounds,
    heuristicRank: ranking.findIndex((r) => r.sha === culpritSha) + 1,
    ranking,
    testRuns,
    search,
  };
}

export function huntToMarkdown(r: HuntResult, repoUrl?: string): string {
  const link = (sha: string, short: string) => (repoUrl ? `[\`${short}\`](${repoUrl.replace(/\.git$/, "")}/commit/${sha})` : `\`${short}\``);
  const lines = [
    `### Culprit: ${link(r.culprit.sha, r.culprit.shortSha)} ${r.culprit.title}`,
    "",
    `Found with **${r.strategy}** search over ${r.range.commits} commit(s) in ${r.runs} sandboxed test run(s) across ${r.rounds} round(s). Confidence: **${(r.confidence * 100).toFixed(1)}%**.`,
    `The ranker had placed it **#${r.heuristicRank}** of ${r.range.commits} before any test ran.`,
    "",
    "| Commit | Result | Duration |",
    "|---|---|---:|",
    ...r.testRuns.map((t) => `| ${link(t.sha, t.sha.slice(0, 7))} | ${t.verdict === "pass" ? "pass" : t.timedOut ? "fail (timeout)" : "fail"} | ${(t.durationMs / 1000).toFixed(1)}s |`),
    "",
    "<details><summary>Top risk signals on the culprit</summary>",
    "",
    ...(r.culprit.topSignals.length ? r.culprit.topSignals.map((s) => `- ${s}`) : ["- none (the heuristics did not flag it)"]),
    "",
    "</details>",
  ];
  return lines.join("\n");
}
