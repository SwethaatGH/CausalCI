// Job processing loop shared by apps/worker and the API's optional inline mode.
import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOk } from "./exec";
import { huntCulprit, type HuntResult } from "./hunt";
import type { BisectJob, JobQueue, VerifyResult } from "./queue";
import { DockerSandbox, KubernetesSandbox, type RunResult, type TestRunner } from "./sandbox";

export interface WorkerHooks {
  onJobStart?: (job: BisectJob) => void;
  onJobEnd?: (job: BisectJob, outcome: "succeeded" | "failed", seconds: number) => void;
  onTestRun?: (r: RunResult) => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface WorkerOptions {
  sandbox: "docker" | "kubernetes";
  /** Directory for cached clones, reused across jobs on the same repository. */
  cacheDir?: string;
  runtime?: string;
  image?: string;
  namespace?: string;
  timeoutMs?: number;
}

/** Clones once per repository URL, then fetches; bisects need full history, never a shallow clone. */
export async function cachedClone(url: string, cacheDir: string): Promise<string> {
  if (!/^https:\/\//.test(url)) throw new Error("Only https:// repository URLs are accepted for jobs");
  const dir = join(cacheDir, createHash("sha256").update(url).digest("hex").slice(0, 16));
  const exists = await access(join(dir, ".git")).then(
    () => true,
    () => false,
  );
  if (exists) await runOk("git", ["-C", dir, "fetch", "--quiet", "--no-tags", "origin"], { timeoutMs: 10 * 60_000 });
  else {
    await mkdir(cacheDir, { recursive: true });
    await runOk("git", ["clone", "--quiet", "--no-tags", "--", url, dir], { timeoutMs: 15 * 60_000 });
  }
  return dir;
}

export function runnerFor(job: BisectJob, repoDir: string, o: WorkerOptions): TestRunner {
  const limits = o.timeoutMs ? { timeoutMs: o.timeoutMs } : undefined;
  if (o.sandbox === "kubernetes")
    return new KubernetesSandbox({ repoUrl: job.input.repoUrl, testCommand: job.input.testCommand, installCommand: job.input.installCommand, runtimeClassName: o.runtime, image: o.image, namespace: o.namespace, limits });
  return new DockerSandbox({ repo: repoDir, testCommand: job.input.testCommand, installCommand: job.input.installCommand, runtime: o.runtime, image: o.image, limits });
}

export async function processJob(job: BisectJob, o: WorkerOptions, hooks: WorkerHooks = {}): Promise<HuntResult | VerifyResult> {
  const repoDir = await cachedClone(job.input.repoUrl, o.cacheDir ?? join(tmpdir(), "causalci-cache"));
  const base = runnerFor(job, repoDir, o);
  const runner: TestRunner = {
    kind: base.kind,
    run: async (sha) => {
      const r = await base.run(sha);
      hooks.onTestRun?.(r);
      return r;
    },
  };
  if (job.input.kind === "verify") {
    const r = await runner.run(job.input.bad, { patch: job.input.patch });
    return { kind: "verify", sha: r.sha, verdict: r.verdict, timedOut: r.timedOut, durationMs: r.durationMs, logTail: r.logTail };
  }
  return huntCulprit({ repo: repoDir, good: job.input.good, bad: job.input.bad, runner, strategy: job.input.strategy, parallel: job.input.parallel });
}

/** Claims and processes jobs until `signal` aborts; the job in progress always finishes. */
export async function workLoop(queue: JobQueue, o: WorkerOptions, signal: AbortSignal, hooks: WorkerHooks = {}): Promise<void> {
  const log = hooks.log ?? (() => undefined);
  while (!signal.aborted) {
    const job = await queue.claim(5);
    if (!job) continue;
    const started = Date.now();
    hooks.onJobStart?.(job);
    log("job started", { id: job.id, repo: job.input.repoUrl });
    try {
      const out = await processJob(job, o, hooks);
      if ("kind" in out && out.kind === "verify") {
        await queue.complete(job.id, out);
        log("job succeeded", { id: job.id, verify: out.verdict });
      } else {
        const { search, ...result } = out as HuntResult;
        await queue.complete(job.id, { kind: "bisect", ...result, posterior: search.posterior });
        log("job succeeded", { id: job.id, culprit: result.culprit.sha, runs: result.runs });
      }
      hooks.onJobEnd?.(job, "succeeded", (Date.now() - started) / 1000);
    } catch (err) {
      await queue.fail(job.id, (err as Error).message);
      hooks.onJobEnd?.(job, "failed", (Date.now() - started) / 1000);
      log("job failed", { id: job.id, error: (err as Error).message });
    }
  }
}
