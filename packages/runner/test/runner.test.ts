import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LocalRunner,
  MemoryQueue,
  commitRange,
  evaluateLabels,
  huntCulprit,
  installContainerArgs,
  loadCommit,
  mineReverts,
  mineSzz,
  parseBlamePorcelain,
  parseGitPatch,
  runOk,
  sandboxJobManifest,
  testContainerArgs,
  toRanges,
  DEFAULT_LIMITS,
  GitMirror,
  INSTALL_SCRIPT,
  NODE_MODULES_MANIFEST,
  TEST_SCRIPT,
  defaultInstallCommand,
  dependencyKey,
} from "../src";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "causalci-test-repo-"));
  const g = (...args: string[]) => runOk("git", ["-C", dir, ...args]);
  await g("init", "--quiet", "--initial-branch=main");
  await g("config", "user.email", "test@example.com");
  await g("config", "user.name", "Test");
  await g("config", "commit.gpgsign", "false");
  return dir;
}

async function commit(dir: string, files: Record<string, string>, message: string): Promise<string> {
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await writeFile(join(dir, p), c);
  }
  await runOk("git", ["-C", dir, "add", "-A"]);
  await runOk("git", ["-C", dir, "commit", "--quiet", "-m", message]);
  return (await runOk("git", ["-C", dir, "rev-parse", "HEAD"])).trim();
}

const CHECK = `const { discount } = require("./pricing.js");
let total;
try { total = discount(100, 150); } catch (e) { if (!(e instanceof RangeError)) throw e; total = 0; }
if (total < 0) { console.error("negative total"); process.exit(1); }
console.log("ok");
`;
const SAFE = `exports.discount = function discount(total, pct) {
  if (pct < 0 || pct > 100) throw new RangeError("bad pct");
  return total - (total * Math.min(pct, 60)) / 100;
};
`;
const BROKEN = `exports.discount = function discount(total, pct) {
  return total - (total * pct) / 100;
};
`;

describe("git adapter and culprit hunt", () => {
  let repo = "";
  const shas: string[] = [];
  beforeAll(async () => {
    repo = await makeRepo();
    shas.push(await commit(repo, { "pricing.js": SAFE, "check.js": CHECK, "README.md": "# shop\n" }, "Initial pricing"));
    for (let i = 1; i <= 5; i++) shas.push(await commit(repo, { [`note${i}.md`]: `note ${i}\n` }, `Add note ${i}`));
    shas.push(await commit(repo, { "pricing.js": BROKEN }, "Refactor discount for seasonal promos"));
    for (let i = 6; i <= 9; i++) shas.push(await commit(repo, { [`note${i}.md`]: `note ${i}\n` }, `Add note ${i}`));
  });
  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("lists the range after good up to bad, oldest first", async () => {
    const range = await commitRange(repo, shas[0], shas[shas.length - 1]);
    expect(range).toEqual(shas.slice(1));
  });

  it("loads a commit with parsed per-file patches", async () => {
    const c = await loadCommit(repo, shas[6]);
    expect(c.message).toBe("Refactor discount for seasonal promos");
    const f = c.files.find((x) => x.path === "pricing.js")!;
    expect(f.status).toBe("modified");
    expect(f.deletions).toBe(2);
    expect(f.patch).toMatch(/^@@ /);
  });

  it("rejects refs that look like options", async () => {
    await expect(commitRange(repo, "--upload-pack=evil", shas[1])).rejects.toThrow(/Invalid ref/);
  });

  it.each(["binary", "k-ary", "bayesian"] as const)("finds the injected regression with %s search", async (strategy) => {
    const runner = new LocalRunner({ repo, testCommand: "node check.js", iUnderstandThisRunsUntrustedCode: true, timeoutMs: 30_000 });
    const r = await huntCulprit({ repo, good: shas[0], bad: shas[shas.length - 1], runner, strategy, parallel: 3 });
    expect(r.culprit.sha).toBe(shas[6]);
    expect(r.confidence).toBeGreaterThan(0.9);
    expect(r.heuristicRank).toBe(1);
    expect(r.runs).toBeLessThanOrEqual(shas.length - 1);
  }, 60_000);

  it("refuses to run code locally without an explicit opt-in", () => {
    expect(() => new LocalRunner({ repo, testCommand: "true", iUnderstandThisRunsUntrustedCode: false })).toThrow(/opt in/);
  });
});

describe("SZZ and evaluation", () => {
  let repo = "";
  let introducing = "";
  let reverted = "";
  beforeAll(async () => {
    repo = await makeRepo();
    await commit(repo, { "pricing.js": SAFE, "check.js": CHECK }, "Initial pricing");
    for (let i = 0; i < 3; i++) await commit(repo, { [`a${i}.md`]: "x\n" }, `Docs ${i}`);
    introducing = await commit(repo, { "pricing.js": SAFE.replace("Math.min(pct, 60)", "pct") }, "Allow uncapped promos");
    await commit(repo, { "b.md": "y\n" }, "More docs");
    await commit(repo, { "pricing.js": SAFE }, "Fix: cap stacked discounts at 60%");
    reverted = await commit(repo, { "shipping.js": "exports.ship = () => 0;\n" }, "Make shipping free");
    await runOk("git", ["-C", repo, "revert", "--no-edit", reverted]);
  });
  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("blames the fix's deleted lines on the introducing commit", async () => {
    const labels = await mineSzz(repo);
    expect(labels).toHaveLength(1);
    expect(labels[0].introducingSha).toBe(introducing);
    expect(labels[0].support).toBe(1);
  });

  it("labels reverted commits directly", async () => {
    const labels = await mineReverts(repo);
    expect(labels.map((l) => l.introducingSha)).toEqual([reverted]);
  });

  it("ranks the true introducer and compares against baselines", async () => {
    const labels = await mineSzz(repo);
    const { summary, cases } = await evaluateLabels(repo, labels, { window: 10 });
    expect(summary.cases).toBe(1);
    expect(cases[0].ranks.heuristic).toBe(1);
    expect(summary.metrics.heuristic!.top1).toBe(1);
    expect(summary.metrics.random!.top1).toBeLessThan(0.5);
  });

  it("parses new, deleted and binary files from git patches", () => {
    const files = parseGitPatch(
      "diff --git a/new.js b/new.js\nnew file mode 100644\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1 @@\n+x\n" +
        "diff --git a/old.js b/old.js\ndeleted file mode 100644\n--- a/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-y\n" +
        "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n",
    );
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary])).toEqual([
      ["new.js", "added", 1, 0, false],
      ["old.js", "removed", 0, 1, false],
      ["logo.png", "modified", 0, 0, true],
    ]);
  });

  it("parses blame porcelain and builds blame ranges", () => {
    const sha = "a".repeat(40);
    expect(parseBlamePorcelain(`${sha} 3 3 2\nauthor X\n\tline\n${sha} 4 4\n\tline2\n`)).toEqual([sha, sha]);
    expect(toRanges([5, 3, 4, 9, 10, 1])).toEqual([[1, 1], [3, 5], [9, 10]]);
  });
});

describe("sandbox isolation contract", () => {
  const base = { name: "t", worktree: "/w", depsVolume: "v", image: "node:22", limits: DEFAULT_LIMITS };

  it("test containers have no network, no capabilities, a read-only root and a non-root user", () => {
    const args = testContainerArgs({ ...base, testCommand: "npm test" });
    for (const flag of ["--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=1000:1000", "--volume=/w:/src:ro", "--volume=v:/deps:ro"]) expect(args).toContain(flag);
    expect(args.some((a) => a.startsWith("--tmpfs=/work:") && a.includes("uid=1000"))).toBe(true);
    expect(args.some((a) => a.startsWith("--pids-limit="))).toBe(true);
    expect(args.some((a) => a.startsWith("--memory="))).toBe(true);
  });

  it("only the install step may write dependencies, and the source stays read-only", () => {
    const args = installContainerArgs({ ...base, installCommand: "npm ci" });
    expect(args).toContain("--volume=/w:/src:ro");
    expect(args).toContain("--volume=v:/deps");
    expect(args).not.toContain("--privileged");
  });

  it("gVisor is opt-in through the runtime flag", () => {
    expect(testContainerArgs({ ...base, testCommand: "x", runtime: "runsc" })).toContain("--runtime=runsc");
  });

  it("Kubernetes jobs run restricted, without a service-account token, and never retry", () => {
    const job = sandboxJobManifest({ name: "j", sha: "abc1234", repoUrl: "https://github.com/x/y", testCommand: "npm test", runtimeClassName: "gvisor" });
    const pod = job.spec.template.spec;
    expect(job.spec.backoffLimit).toBe(0);
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.runtimeClassName).toBe("gvisor");
    for (const c of [...pod.initContainers, ...pod.containers]) {
      expect(c.securityContext.readOnlyRootFilesystem).toBe(true);
      expect(c.securityContext.allowPrivilegeEscalation).toBe(false);
      expect(c.securityContext.capabilities.drop).toEqual(["ALL"]);
    }
  });
});

describe("memory job queue", () => {
  it("hands each job to exactly one claimer and records the result", async () => {
    const q = new MemoryQueue();
    const waiting = q.claim(5);
    const job = await q.enqueue({ repoUrl: "https://github.com/x/y", good: "a", bad: "b", testCommand: "npm test" });
    const claimed = (await waiting)!;
    expect(claimed.id).toBe(job.id);
    expect(claimed.state).toBe("running");
    await q.complete(job.id, { culprit: "c" });
    expect((await q.get(job.id))!.state).toBe("succeeded");
    expect(await q.claim(0.05)).toBeNull();
    await q.close();
  });
});

describe("git mirror (partial clone)", () => {
  let origin = "";
  let cache = "";
  const shas: string[] = [];
  beforeAll(async () => {
    origin = await makeRepo();
    cache = await mkdtemp(join(tmpdir(), "causalci-mirror-"));
    shas.push(await commit(origin, { "a.ts": "export const a = 1;\n" }, "First"));
    shas.push(await commit(origin, { "a.ts": "export const a = 2;\n", "dir/b.py": "def b():\n    return 1\n" }, "Second"));
    shas.push(await commit(origin, { "big.txt": "x\n".repeat(50) }, "Third"));
  });
  afterAll(async () => {
    await rm(origin, { recursive: true, force: true });
    await rm(cache, { recursive: true, force: true });
  });

  it("serves branches, history, untruncated diffs, files and the full tree", async () => {
    const m = new GitMirror(`file://${origin}`, cache);
    expect((await m.branches()).map((b) => b.name)).toContain("main");
    const log = await m.log("main", { limit: 10 });
    expect(log.map((c) => c.sha)).toEqual([...shas].reverse());
    expect(log[0].files).toEqual([]);
    const c = await m.commit(shas[1]);
    expect(c.files.map((f) => f.path).sort()).toEqual(["a.ts", "dir/b.py"]);
    expect(c.files.find((f) => f.path === "a.ts")!.patch).toContain("+export const a = 2;");
    const between = await m.between(shas[0], shas[2], 10);
    expect(between.commits.map((x) => x.sha)).toEqual(shas.slice(1));
    await expect(m.between(shas[2], shas[0], 10)).rejects.toThrow(/does not come after/);
    expect((await m.diff(shas[0], shas[2])).map((f) => f.path).sort()).toEqual(["a.ts", "big.txt", "dir/b.py"]);
    expect(await m.file("a.ts", shas[0], 1000)).toBe("export const a = 1;\n");
    expect(await m.file("missing.ts", shas[0], 1000)).toBeNull();
    await expect(m.file("big.txt", "main", 10)).rejects.toThrow(/exceeds/);
    expect((await m.tree("main")).paths.sort()).toEqual(["a.ts", "big.txt", "dir/b.py"]);
  });

  it("rejects URLs that are not clone URLs", () => {
    expect(() => new GitMirror("https://github.com/a/b; rm -rf /", cache)).toThrow(/Unsupported/);
  });
});

describe("workspace-aware dependency cache", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "causalci-deps-"));
    for (const d of ["src", "deps", "work"]) await mkdir(join(root, d), { recursive: true });
    await writeFile(join(root, "src/package.json"), '{"workspaces":["packages/*"]}');
    await mkdir(join(root, "src/packages/a"), { recursive: true });
    await writeFile(join(root, "src/packages/a/index.js"), "module.exports = 1;\n");
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  // The container paths become temp folders so the real scripts run unchanged.
  const local = (script: string) => script.replaceAll("/src", `${root}/src`).replaceAll("/deps", `${root}/deps`).replaceAll("/work", `${root}/work`);

  it("installs once, records every node_modules (root and workspaces), and links them into each test run", async () => {
    const install = await runOk("sh", ["-c", local(INSTALL_SCRIPT)], { env: { ...process.env, CAUSALCI_INSTALL: "mkdir -p node_modules/lib packages/a/node_modules/only-in-a && echo ok > packages/a/node_modules/only-in-a/marker" } });
    expect(install).toBe("");
    const { readFile } = await import("node:fs/promises");
    expect((await readFile(join(root, "deps", NODE_MODULES_MANIFEST), "utf8")).trim().split("\n").sort()).toEqual(["node_modules", "packages/a/node_modules"]);
    const out = await runOk("sh", ["-c", local(TEST_SCRIPT)], { env: { ...process.env, CAUSALCI_TEST: "cat packages/a/node_modules/only-in-a/marker && test -d node_modules/lib && test -f packages/a/index.js && echo tests-ran" } });
    expect(out).toContain("ok");
    expect(out).toContain("tests-ran");
  });

  it("picks the install command from the lockfile and keys the cache on workspace manifests too", async () => {
    const repo = await makeRepo();
    await commit(repo, { "package.json": "{}", "pnpm-lock.yaml": "lockfileVersion: 9\n", "packages/a/package.json": '{"name":"a"}' }, "init");
    expect(await defaultInstallCommand(repo)).toMatch(/pnpm install --frozen-lockfile --ignore-scripts/);
    const k1 = await dependencyKey(repo, "x", "img");
    await writeFile(join(repo, "packages/a/package.json"), '{"name":"a","dependencies":{"b":"1"}}');
    expect(await dependencyKey(repo, "x", "img")).not.toBe(k1);
    await rm(repo, { recursive: true, force: true });
  });

  it("applies a proposed patch before running, and fails cleanly when it does not apply", async () => {
    const repo = await makeRepo();
    const sha = await commit(repo, { "check.js": "process.exit(1);\n" }, "broken");
    const runner = new LocalRunner({ repo, testCommand: "node check.js", iUnderstandThisRunsUntrustedCode: true, timeoutMs: 20_000 });
    expect((await runner.run(sha)).verdict).toBe("fail");
    const fix = "--- a/check.js\n+++ b/check.js\n@@ -1 +1 @@\n-process.exit(1);\n+process.exit(0);\n";
    expect((await runner.run(sha, { patch: fix })).verdict).toBe("pass");
    const bad = await runner.run(sha, { patch: "--- a/nope.js\n+++ b/nope.js\n@@ -1 +1 @@\n-x\n+y\n" });
    expect(bad.verdict).toBe("fail");
    expect(bad.logTail).toMatch(/does not apply/);
    await rm(repo, { recursive: true, force: true });
  }, 30_000);
});
