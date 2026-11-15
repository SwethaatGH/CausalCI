import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { rankSuspects } from "@causalci/analysis";
import { confirmWithTestsSchema, type BisectResult } from "@causalci/shared";
import { DockerSandbox, type BisectJob, type JobQueue } from "@causalci/runner";
import { env } from "../config";
import type { DB } from "../db";
import { ApiError, notFound } from "../errors";

const refSchema = z.string().regex(/^[\w./~^-]{1,200}$/).refine((s) => !s.startsWith("-"), "must not start with '-'");

const createJobSchema = z.object({
  repoUrl: z.string().url().regex(/^https:\/\//, "must be an https:// clone URL"),
  good: refSchema,
  bad: refSchema,
  testCommand: z.string().trim().min(1).max(500),
  installCommand: z.string().trim().min(1).max(500).optional(),
  strategy: z.enum(["binary", "k-ary", "bayesian"]).default("bayesian"),
  parallel: z.number().int().min(1).max(16).default(1),
});

function authorize(req: FastifyRequest) {
  if (!env.jobsToken) return;
  const got = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(env.jobsToken);
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new ApiError(401, "UNAUTHORIZED", "A valid bearer token is required to create bisect jobs.");
}

/** Whether this server can run the repository's tests, and if not, what to change. Shown in the UI. */
export async function jobsConfig() {
  if (env.publicDemo) return { enabled: false, reason: "Test runs are turned off on this public demo. Run CausalCI yourself to use them." };
  if (!env.bisectJobsEnabled) return { enabled: false, reason: "Test runs are off. Set BISECT_JOBS_ENABLED=true on the server to turn them on." };
  if (!process.env.REDIS_URL && !(await DockerSandbox.available()))
    return { enabled: false, reason: "Docker isn't reachable from the server, so there is no sandbox to run tests in. Start Docker, or run a worker with REDIS_URL." };
  return { enabled: true, reason: null, executor: process.env.REDIS_URL ? "queue" : "inline" };
}

/**
 * Sandboxed test jobs. Creating one makes a worker run the target repository's test command, so the
 * endpoints are off unless BISECT_JOBS_ENABLED=true, never on in PUBLIC_DEMO, and optionally guarded
 * by JOBS_TOKEN. Jobs started from an investigation write their results back to it.
 */
export function registerJobRoutes(app: FastifyInstance, queue: JobQueue, db: DB) {
  const enabled = () => {
    if (env.publicDemo || !env.bisectJobsEnabled)
      throw new ApiError(403, "JOBS_DISABLED", "Sandboxed test runs are disabled on this server. Set BISECT_JOBS_ENABLED=true (never on a public demo) and run a worker.");
  };

  /** Applies a finished job to the investigation it came from, once. */
  const applyResult = (job: BisectJob) => {
    const invId = job.input.investigationId;
    if (job.state !== "succeeded" || !invId) return;
    const key = `job-applied:${job.id}`;
    if (db.cacheGet<boolean>(key)) return;
    const inv = db.getInvestigation(invId);
    const analysis = db.getAnalysis(invId);
    if (!inv || !analysis) return;
    const result = job.result as { kind?: string; verdict?: string; culprit?: { sha: string }; testRuns?: { sha: string; verdict: string }[] };
    if (result.kind === "verify" && job.input.patchId) {
      const patch = db.getPatch(job.input.patchId);
      if (patch) db.savePatch({ ...patch, verified: result.verdict === "pass" }, inv.id);
    } else if (result.culprit) {
      const chrono = [...analysis.commits].reverse();
      const idx = chrono.findIndex((c) => c.sha === result.culprit!.sha);
      const bisect: BisectResult = {
        firstBadSha: result.culprit.sha,
        lastGoodSha: idx > 0 ? chrono[idx - 1].sha : (chrono[0]?.parents[0] ?? null),
        steps: (result.testRuns ?? []).map((r) => ({ sha: r.sha, passed: r.verdict === "pass" })),
        verification: [],
      };
      const updated = { ...analysis, bisect };
      db.saveAnalysis(updated);
      const findings = inv.mode === "exploration" ? inv.findings : rankSuspects(updated.commits, updated.assessments, { bisect });
      db.saveInvestigation({ ...inv, findings, knownBadSha: bisect.firstBadSha, knownGoodSha: inv.knownGoodSha ?? bisect.lastGoodSha, updatedAt: new Date().toISOString() });
    }
    db.cacheSet(key, true, null);
  };

  app.get("/api/bisect-jobs/config", async () => jobsConfig());

  app.post("/api/bisect-jobs", async (req, reply) => {
    enabled();
    authorize(req);
    const job = await queue.enqueue(createJobSchema.parse(req.body));
    return reply.status(202).send(job);
  });

  app.get<{ Params: { id: string } }>("/api/bisect-jobs/:id", async (req) => {
    enabled();
    const job = await queue.get(req.params.id);
    if (!job) throw notFound("Test job");
    applyResult(job);
    return job;
  });

  /** "Confirm with tests": run the repository's tests across the investigation's range in sandboxes. */
  app.post<{ Params: { id: string } }>("/api/investigations/:id/confirm", async (req, reply) => {
    enabled();
    authorize(req);
    const inv = db.getInvestigation(req.params.id);
    if (!inv) throw notFound("Investigation");
    if (inv.isDemo) throw new ApiError(422, "DEMO_USES_BUILT_IN_CHECKS", "The demo already runs its built-in checks; test runs are for real repositories.");
    const analysis = db.getAnalysis(inv.id);
    if (!analysis?.commits.length) throw new ApiError(409, "NOT_ANALYZED", "Run the analysis before confirming with tests.");
    const body = confirmWithTestsSchema.parse(req.body ?? {});
    const oldest = analysis.commits[analysis.commits.length - 1];
    const good = inv.knownGoodSha ?? oldest.parents[0];
    if (!good) throw new ApiError(422, "NO_GOOD_COMMIT", "The oldest commit in range has no parent to use as the last good version. Start a “Between good and bad” investigation instead.");
    const job = await queue.enqueue({
      kind: "bisect",
      repoUrl: `https://github.com/${inv.repositoryId}.git`,
      good,
      bad: inv.knownBadSha ?? analysis.commits[0].sha,
      testCommand: body.testCommand,
      installCommand: body.installCommand,
      strategy: body.strategy,
      parallel: body.parallel,
      investigationId: inv.id,
    });
    db.saveInvestigation({ ...inv, testJobId: job.id, updatedAt: new Date().toISOString() });
    return reply.status(202).send(job);
  });

  /** "Run the checks" on a real repository: the proposed fix is applied at the newest commit and the tests run there. */
  app.post<{ Params: { id: string; patchId: string }; Body: { testCommand?: string; installCommand?: string } }>("/api/investigations/:id/patches/:patchId/verify-in-sandbox", async (req, reply) => {
    enabled();
    authorize(req);
    const inv = db.getInvestigation(req.params.id);
    if (!inv) throw notFound("Investigation");
    const patch = db.getPatch(req.params.patchId);
    if (!patch) throw notFound("Patch");
    if (!patch.patchValid) throw new ApiError(422, "INVALID_PATCH", `The patch is not well-formed: ${patch.patchError}`);
    const analysis = db.getAnalysis(inv.id);
    const head = analysis?.commits[0];
    if (!head) throw new ApiError(409, "NOT_ANALYZED", "Run the analysis first.");
    const body = z.object({ testCommand: z.string().trim().min(1).max(500).default("npm test"), installCommand: z.string().trim().min(1).max(500).optional() }).parse(req.body ?? {});
    const job = await queue.enqueue({
      kind: "verify",
      repoUrl: `https://github.com/${inv.repositoryId}.git`,
      good: head.sha,
      bad: head.sha,
      testCommand: body.testCommand,
      installCommand: body.installCommand,
      patch: patch.patch,
      investigationId: inv.id,
      patchId: patch.id,
    });
    return reply.status(202).send(job);
  });
}
