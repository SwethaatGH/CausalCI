#!/usr/bin/env -S npx tsx
// causalci: find the commit that broke the build, from a terminal or a CI job.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_SCENARIOS, benchToMarkdown, buildDependencyGraph, isTestPath, runScenario, selectTests, suspectRangeFromSignal, type Deploy, type SeriesPoint } from "@causalci/analysis";
import {
  DockerSandbox,
  KubernetesSandbox,
  LocalRunner,
  commitRange,
  crossValidateLearned,
  evalToMarkdown,
  evaluateLabels,
  pooledSummary,
  summarize,
  huntCulprit,
  huntToMarkdown,
  loadCommit,
  loadSourceFiles,
  mineLabels,
  rankRange,
  resolveSha,
  type RegressionLabel,
  type Strategy,
  type TestRunner,
} from "@causalci/runner";

const HELP = `causalci <command> [options]

Commands
  bisect        Find the first bad commit in (good, bad] by running tests in a sandbox
  rank          Rank the commits in (good, bad] by heuristic risk, without running anything
  select-tests  List the test files that can reach a commit's changes
  mine          Mine labelled regressions (SZZ + reverts) from a repository's history
  eval          Evaluate the ranker against mined labels, with baselines
  bench         Simulate bisection strategies on flaky suites
  signal        Map an error-rate shift to the deploy (and commit range) that caused it

Common options
  --repo <path>          Local clone (default: .)
  --good <ref>           Last known-good commit
  --bad <ref>            First known-bad commit (default: HEAD)
  --json                 Machine-readable output

bisect options
  --test <cmd>           Test command, e.g. "npm test" (required)
  --install <cmd>        Dependency install (default: npm ci --ignore-scripts)
  --strategy <s>         binary | k-ary | bayesian (default: bayesian)
  --parallel <k>         Test runs per round (default: 1; k-ary default 4)
  --sandbox <s>          docker | kubernetes | local (default: docker)
  --runtime <r>          Docker runtime, e.g. runsc for gVisor
  --image <img>          Sandbox image (default: node:22-bookworm-slim)
  --repo-url <url>       Clone URL (kubernetes sandbox)
  --timeout <sec>        Per-run limit (default: 600)
  --no-prior             Do not seed the search with risk scores
  --markdown <file>      Also write a Markdown report (used by the GitHub Action)
  --i-understand-local   Required with --sandbox local (runs repo code on this machine)

mine / eval options
  --max-fixes <n>        Fix commits to examine (default: 150)
  --labels <file>        Labels JSON from "mine" (eval mines on the fly when omitted)
  --window <n>           Commits ranked per case (default: 20)
  --out <file>           Write JSON results here

signal options
  --series <file>        JSON [{t, v}] (unix seconds), e.g. exported from Prometheus
  --deploys <file>       JSON [{sha, t}]
`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: "string", multiple: true, default: ["."] },
    good: { type: "string" },
    bad: { type: "string", default: "HEAD" },
    sha: { type: "string" },
    test: { type: "string" },
    install: { type: "string" },
    strategy: { type: "string", default: "bayesian" },
    parallel: { type: "string" },
    sandbox: { type: "string", default: "docker" },
    runtime: { type: "string" },
    image: { type: "string" },
    "repo-url": { type: "string" },
    timeout: { type: "string", default: "600" },
    "no-prior": { type: "boolean", default: false },
    markdown: { type: "string" },
    "i-understand-local": { type: "boolean", default: false },
    "max-fixes": { type: "string", default: "150" },
    labels: { type: "string" },
    window: { type: "string", default: "20" },
    trials: { type: "string", default: "1000" },
    out: { type: "string" },
    series: { type: "string" },
    deploys: { type: "string" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const repos = o.repo!.map((r) => resolve(r));
const repo = repos[0];
const print = (human: string, data: unknown) => console.log(o.json ? JSON.stringify(data, null, 2) : human);
const need = (v: string | undefined, flag: string) => {
  if (!v) throw new Error(`${flag} is required (see causalci --help)`);
  return v;
};

function makeRunner(): TestRunner {
  const testCommand = need(o.test, "--test");
  const limits = { timeoutMs: Number(o.timeout) * 1000 };
  switch (o.sandbox) {
    case "docker":
      return new DockerSandbox({ repo, testCommand, installCommand: o.install, image: o.image, runtime: o.runtime, limits });
    case "kubernetes":
      return new KubernetesSandbox({ repoUrl: need(o["repo-url"], "--repo-url"), testCommand, installCommand: o.install, image: o.image, runtimeClassName: o.runtime, limits, namespace: process.env.CAUSALCI_NAMESPACE });
    case "local":
      return new LocalRunner({ repo, testCommand, installCommand: o.install, timeoutMs: limits.timeoutMs, iUnderstandThisRunsUntrustedCode: o["i-understand-local"]! });
    default:
      throw new Error(`Unknown --sandbox ${o.sandbox}`);
  }
}

async function main() {
  const cmd = positionals[0];
  if (!cmd || o.help) return console.log(HELP);

  if (cmd === "bisect") {
    const runner = makeRunner();
    if (runner instanceof DockerSandbox && !(await DockerSandbox.available())) throw new Error("Docker is not reachable. Start Docker, or use --sandbox kubernetes / --sandbox local inside a disposable CI runner.");
    const strategy = o.strategy as Strategy;
    const result = await huntCulprit({
      repo,
      good: need(o.good, "--good"),
      bad: o.bad!,
      runner,
      strategy,
      parallel: o.parallel ? Number(o.parallel) : strategy === "k-ary" ? 4 : 1,
      usePrior: !o["no-prior"],
      onRun: (r) => !o.json && console.error(`  ${r.sha.slice(0, 7)}  ${r.verdict.padEnd(4)}  ${(r.durationMs / 1000).toFixed(1)}s${r.cacheHit === false ? "  (dependencies installed)" : ""}`),
    });
    const md = huntToMarkdown(result, process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}` : undefined);
    if (o.markdown) await writeFile(o.markdown, md);
    const { search, ...rest } = result;
    return print(md, { ...rest, posterior: search.posterior });
  }

  if (cmd === "rank") {
    const shas = await commitRange(repo, need(o.good, "--good"), o.bad!);
    const { ranking } = await rankRange(repo, shas);
    return print(ranking.map((r, i) => `${String(i + 1).padStart(3)}. ${r.shortSha}  ${(r.likelihood * 100).toFixed(0).padStart(3)}%  risk ${String(r.score).padStart(3)}  ${r.title}${r.topSignals.length ? `\n        ${r.topSignals.join(" · ")}` : ""}`).join("\n"), ranking);
  }

  if (cmd === "select-tests") {
    const sha = await resolveSha(repo, o.sha ?? o.bad!);
    const [commit, files] = await Promise.all([loadCommit(repo, sha), loadSourceFiles(repo, sha)]);
    const { graph } = buildDependencyGraph(files, { headSha: sha });
    const sel = selectTests(graph, { changedFiles: commit.files.map((f) => f.path), allTests: files.map((f) => f.path).filter(isTestPath) });
    return print([...sel.reasons, "", ...(sel.runAll ? ["(all tests)"] : sel.selected), "", `${sel.selected.length} selected, ${sel.skipped.length} skipped`].join("\n"), sel);
  }

  if (cmd === "mine") {
    const labels = await mineLabels(repo, { maxFixes: Number(o["max-fixes"]) });
    if (o.out) await writeFile(o.out, JSON.stringify(labels, null, 2));
    return print(`${labels.length} labelled regression(s): ${labels.filter((l) => l.method === "revert").length} from reverts, ${labels.filter((l) => l.method === "szz").length} from SZZ`, labels);
  }

  if (cmd === "eval") {
    const window = Number(o.window);
    const byRepo: { repo: string; cases: Awaited<ReturnType<typeof evaluateLabels>>["cases"]; skipped: number }[] = [];
    for (const r of repos) {
      // Labels are cached next to the repository so re-running the evaluation does not re-mine.
      const cacheFile = o.labels && repos.length === 1 ? o.labels : `${r}.causalci-labels.json`;
      const labels: RegressionLabel[] = await readFile(cacheFile, "utf8").then(
        (t) => JSON.parse(t),
        async () => {
          if (!o.json) console.error(`mining ${r} …`);
          const mined = await mineLabels(r, { maxFixes: Number(o["max-fixes"]) });
          await writeFile(cacheFile, JSON.stringify(mined, null, 2));
          return mined;
        },
      );
      const { summary, cases } = await evaluateLabels(r, labels, { window });
      byRepo.push({ repo: summary.repo, cases, skipped: summary.skipped });
    }
    const model = crossValidateLearned(byRepo);
    const summaries = byRepo.map((r) => summarize(r.repo, r.cases, r.skipped, window));
    if (byRepo.length > 1) summaries.push(pooledSummary(byRepo, window));
    const weights = model ? model.featureNames.map((n, i) => ({ feature: n, weight: Number(model.weights[i].toFixed(3)) })).sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)) : [];
    if (o.out) await writeFile(o.out, JSON.stringify({ summaries, weights, cases: byRepo }, null, 2));
    const notes = [
      `${summaries.reduce((s, x) => s + (x.repo.startsWith("all") ? 0 : x.cases), 0)} case(s) evaluated in a ${window}-commit window.`,
      model ? "learned = logistic regression, leave-one-repository-out (never tested on a repo it trained on)." : "learned ranker needs 2+ repositories (pass --repo more than once).",
      ...(weights.length ? ["", "Largest learned weights:", ...weights.slice(0, 6).map((w) => `  ${w.weight >= 0 ? "+" : ""}${w.weight}  ${w.feature}`)] : []),
    ];
    return print(`${evalToMarkdown(summaries)}\n\n${notes.join("\n")}`, { summaries, weights });
  }

  if (cmd === "bench") {
    const results = [];
    for (const s of DEFAULT_SCENARIOS) results.push(await runScenario(s, Number(o.trials), 2026));
    if (o.out) await writeFile(o.out, JSON.stringify(results, null, 2));
    return print(benchToMarkdown(results), results);
  }

  if (cmd === "signal") {
    const series: SeriesPoint[] = JSON.parse(await readFile(need(o.series, "--series"), "utf8"));
    const deploys: Deploy[] = JSON.parse(await readFile(need(o.deploys, "--deploys"), "utf8"));
    const r = suspectRangeFromSignal(series, deploys);
    if (!r) return print("No significant upward shift found, or no deploy precedes it.", null);
    return print(
      `Shift at ${new Date(r.changePoint.t * 1000).toISOString()}: ${r.changePoint.meanBefore.toFixed(3)} → ${r.changePoint.meanAfter.toFixed(3)} (t = ${r.changePoint.tStat.toFixed(1)})\nSuspect deploy ${r.suspectDeploy.sha} went out ${r.lagSeconds}s before it.\nBisect with: causalci bisect --good ${r.lastGoodDeploy?.sha ?? "<last good>"} --bad ${r.suspectDeploy.sha} --test "<cmd>"`,
      r,
    );
  }

  throw new Error(`Unknown command "${cmd}". Run causalci --help.`);
}

main().catch((err: Error) => {
  console.error(`causalci: ${err.message}`);
  process.exit(1);
});
