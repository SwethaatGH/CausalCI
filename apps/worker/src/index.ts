// Bisect worker: claims jobs from the queue and runs each test in a sandbox.
// Scale it horizontally (KEDA scales on the queue length); every replica is stateless apart from
// its clone cache, and SIGTERM lets the job in progress finish before the pod exits.
import { createServer } from "node:http";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { RedisQueue, queueFromEnv, workLoop } from "@causalci/runner";

const env = process.env;
const sandbox = env.SANDBOX === "kubernetes" ? "kubernetes" : "docker";
const port = Number(env.METRICS_PORT ?? 9464);

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: "causalci_worker_" });
const jobs = new Counter({ name: "causalci_bisect_jobs_total", help: "Bisect jobs finished", labelNames: ["outcome"], registers: [registry] });
const jobSeconds = new Histogram({ name: "causalci_bisect_job_duration_seconds", help: "End-to-end bisect job time", buckets: [10, 30, 60, 120, 300, 600, 1200, 3600], registers: [registry] });
const runs = new Counter({ name: "causalci_sandbox_runs_total", help: "Sandboxed test runs", labelNames: ["verdict", "cache"], registers: [registry] });
const runSeconds = new Histogram({ name: "causalci_sandbox_run_duration_seconds", help: "Single sandboxed test run time", buckets: [1, 5, 15, 30, 60, 120, 300, 600], registers: [registry] });
const busy = new Gauge({ name: "causalci_worker_busy", help: "1 while a job is running", registers: [registry] });

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ level: "info", time: new Date().toISOString(), msg, ...extra }));

async function main() {
  const queue = await queueFromEnv();
  const stop = new AbortController();
  let ready = true;

  const server = createServer(async (req, res) => {
    if (req.url === "/metrics") {
      res.setHeader("content-type", registry.contentType);
      return res.end(await registry.metrics());
    }
    if (req.url === "/healthz") return res.end("ok");
    if (req.url === "/readyz") {
      res.statusCode = ready ? 200 : 503;
      return res.end(ready ? "ready" : "draining");
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(port, () => log("worker listening", { port, sandbox, queue: env.REDIS_URL ? "redis" : "memory" }));

  // Requeue jobs whose worker died mid-run (pod evicted, node lost).
  const recovery =
    queue instanceof RedisQueue
      ? setInterval(() => queue.recoverStale(Number(env.STALE_JOB_MS ?? 2 * 3600_000)).then((n) => n && log("requeued stale jobs", { n })), 60_000)
      : null;

  const shutdown = (signal: string) => {
    log("draining", { signal });
    ready = false;
    stop.abort();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await workLoop(
    queue,
    { sandbox, runtime: env.SANDBOX_RUNTIME, image: env.SANDBOX_IMAGE, namespace: env.SANDBOX_NAMESPACE, cacheDir: env.CACHE_DIR, timeoutMs: env.RUN_TIMEOUT_MS ? Number(env.RUN_TIMEOUT_MS) : undefined },
    stop.signal,
    {
      log,
      onJobStart: () => busy.set(1),
      onJobEnd: (_job, outcome, seconds) => {
        busy.set(0);
        jobs.inc({ outcome });
        jobSeconds.observe(seconds);
      },
      onTestRun: (r) => {
        runs.inc({ verdict: r.verdict, cache: r.cacheHit === undefined ? "n/a" : r.cacheHit ? "hit" : "miss" });
        runSeconds.observe(r.durationMs / 1000);
      },
    },
  );
  if (recovery) clearInterval(recovery);
  await queue.close();
  server.close();
  log("worker stopped");
}

main().catch((err: Error) => {
  console.error(JSON.stringify({ level: "error", msg: err.message }));
  process.exit(1);
});
