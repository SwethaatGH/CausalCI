import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { JobQueue } from "@causalci/runner";
import { env } from "../config";
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

/**
 * Sandboxed bisect jobs. Creating one makes a worker run the target repository's test command, so
 * the endpoints are off unless BISECT_JOBS_ENABLED=true, never on in PUBLIC_DEMO, and optionally
 * guarded by JOBS_TOKEN.
 */
export function registerJobRoutes(app: FastifyInstance, queue: JobQueue) {
  const enabled = () => {
    if (env.publicDemo || !env.bisectJobsEnabled)
      throw new ApiError(403, "JOBS_DISABLED", "Sandboxed bisect jobs are disabled on this server. Set BISECT_JOBS_ENABLED=true (never on a public demo) and run a worker.");
  };
  app.post("/api/bisect-jobs", async (req, reply) => {
    enabled();
    authorize(req);
    const job = await queue.enqueue(createJobSchema.parse(req.body));
    return reply.status(202).send(job);
  });
  app.get<{ Params: { id: string } }>("/api/bisect-jobs/:id", async (req) => {
    enabled();
    const job = await queue.get(req.params.id);
    if (!job) throw notFound("Bisect job");
    return job;
  });
}
