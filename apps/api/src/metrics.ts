import type { FastifyInstance } from "fastify";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { JobQueue } from "@causalci/runner";

/** Prometheus metrics for the API: request latency by route, plus the bisect queue depth. */
export function registerMetrics(app: FastifyInstance, queue: JobQueue) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "causalci_api_" });
  const duration = new Histogram({
    name: "causalci_http_request_duration_seconds",
    help: "API request latency",
    labelNames: ["method", "route", "status"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const errors = new Counter({ name: "causalci_http_errors_total", help: "API responses with status >= 500", labelNames: ["route"], registers: [registry] });
  new Gauge({
    name: "causalci_bisect_queue_depth",
    help: "Bisect jobs waiting for a worker",
    registers: [registry],
    async collect() {
      this.set(await queue.depth().catch(() => 0));
    },
  });

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "unmatched";
    if (route === "/metrics") return;
    duration.observe({ method: req.method, route, status: String(reply.statusCode) }, reply.elapsedTime / 1000);
    if (reply.statusCode >= 500) errors.inc({ route });
  });
  app.get("/metrics", async (_req, reply) => reply.header("content-type", registry.contentType).send(await registry.metrics()));
}
