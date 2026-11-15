import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  for (const [p, c] of Object.entries(files)) await writeFile(join(dir, p), c);
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
    for (const flag of ["--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user=1000:1000", "--volume=/w:/src:ro", "--volume=v:/src/node_modules:ro"]) expect(args).toContain(flag);
    expect(args.some((a) => a.startsWith("--pids-limit="))).toBe(true);
    expect(args.some((a) => a.startsWith("--memory="))).toBe(true);
  });

  it("only the install step may write dependencies, and the source stays read-only", () => {
    const args = installContainerArgs({ ...base, installCommand: "npm ci" });
    expect(args).toContain("--volume=/w:/src:ro");
    expect(args).toContain("--volume=v:/src/node_modules");
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
