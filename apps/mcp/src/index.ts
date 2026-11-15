// MCP server: lets coding agents (Claude Code, Cursor, …) check their own changes.
// An agent that just broke a test can ask which commit did it, which tests its edit can reach,
// and how risky a commit range looks, without leaving its loop.
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildDependencyGraph, isTestPath, selectTests } from "@causalci/analysis";
import { DockerSandbox, LocalRunner, commitRange, huntCulprit, huntToMarkdown, loadCommit, loadSourceFiles, rankRange, resolveSha, type TestRunner } from "@causalci/runner";

const ref = z.string().regex(/^[\w./~^-]{1,200}$/).describe("A commit SHA, branch or ref such as HEAD~5");
const repoArg = z.string().default(".").describe("Path to a local git clone");

const server = new McpServer({ name: "causalci", version: "0.1.0" });

const text = (t: string, structured?: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: t }], ...(structured ? { structuredContent: structured } : {}) });

server.registerTool(
  "rank_suspects",
  {
    title: "Rank suspect commits",
    description: "Ranks the commits in (good, bad] with a ranker trained on mined real regressions, explained by evidence-linked risk signals. Runs no code.",
    inputSchema: { repo: repoArg, good: ref, bad: ref.default("HEAD"), top: z.number().int().min(1).max(50).default(10) },
    annotations: { readOnlyHint: true },
  },
  async ({ repo, good, bad, top }) => {
    const dir = resolve(repo);
    const { ranking } = await rankRange(dir, await commitRange(dir, good, bad));
    const rows = ranking.slice(0, top);
    return text(rows.map((r, i) => `${i + 1}. ${r.shortSha} (likelihood ${(r.likelihood * 100).toFixed(0)}%, risk ${r.score}) ${r.title}${r.topSignals.length ? ` [${r.topSignals.join("; ")}]` : ""}`).join("\n") || "No commits in range.", { ranking: rows });
  },
);

server.registerTool(
  "select_tests",
  {
    title: "Select affected tests",
    description: "Lists the test files that can reach a commit's changes through imports and calls. Falls back to the full suite when a change is not traceable.",
    inputSchema: { repo: repoArg, sha: ref.default("HEAD") },
    annotations: { readOnlyHint: true },
  },
  async ({ repo, sha }) => {
    const dir = resolve(repo);
    const full = await resolveSha(dir, sha);
    const [commit, files] = await Promise.all([loadCommit(dir, full), loadSourceFiles(dir, full)]);
    const { graph } = buildDependencyGraph(files, { headSha: full });
    const sel = selectTests(graph, { changedFiles: commit.files.map((f) => f.path), allTests: files.map((f) => f.path).filter(isTestPath) });
    return text([...sel.reasons, ...(sel.runAll ? ["Run the full suite."] : sel.selected.map((t) => `- ${t}`))].join("\n"), { ...sel });
  },
);

server.registerTool(
  "find_culprit",
  {
    title: "Find the culprit commit",
    description:
      "Runs the test command at commits in (good, bad] inside a Docker sandbox (no network, read-only, no capabilities) and returns the first bad commit with its confidence. Uses flaky-aware Bayesian search by default.",
    inputSchema: {
      repo: repoArg,
      good: ref,
      bad: ref.default("HEAD"),
      testCommand: z.string().min(1).max(500).describe('e.g. "npm test"'),
      strategy: z.enum(["binary", "k-ary", "bayesian"]).default("bayesian"),
      parallel: z.number().int().min(1).max(8).default(1),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  async ({ repo, good, bad, testCommand, strategy, parallel }) => {
    const dir = resolve(repo);
    let runner: TestRunner;
    if (await DockerSandbox.available()) runner = new DockerSandbox({ repo: dir, testCommand, runtime: process.env.SANDBOX_RUNTIME });
    else if (process.env.CAUSALCI_ALLOW_LOCAL === "1") runner = new LocalRunner({ repo: dir, testCommand, iUnderstandThisRunsUntrustedCode: true });
    else return { ...text("Docker is not reachable, so no sandbox is available. Start Docker, or set CAUSALCI_ALLOW_LOCAL=1 to run tests directly on this machine (only for repositories you trust)."), isError: true };
    const r = await huntCulprit({ repo: dir, good, bad, runner, strategy, parallel });
    return text(huntToMarkdown(r), { culprit: r.culprit, confidence: r.confidence, runs: r.runs, rounds: r.rounds, heuristicRank: r.heuristicRank });
  },
);

await server.connect(new StdioServerTransport());
