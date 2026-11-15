import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { queueFromEnv, workLoop, type JobQueue } from "@causalci/runner";
import { env } from "./config";
import { openDatabase, type DB } from "./db";
import { registerErrorHandler } from "./errors";
import { registerMetrics } from "./metrics";
import { registerAIRoutes } from "./routes/ai";
import { registerInvestigationRoutes } from "./routes/investigations";
import { registerJobRoutes } from "./routes/jobs";
import { registerSystemRoutes } from "./routes/system";

export async function buildApp(opts: { db?: DB; logger?: boolean; demoPacingMs?: number; queue?: JobQueue } = {}) {
  const db = opts.db ?? openDatabase(env.databasePath);
  const queue = opts.queue ?? (await queueFromEnv());
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, { origin: [env.corsOrigin, /^http:\/\/(localhost|127\.0\.0\.1):\d+$/], methods: ["GET", "POST", "PUT", "PATCH", "DELETE"] });
  registerErrorHandler(app, { spaFallback: !!env.webDistPath });
  registerSystemRoutes(app, db);
  registerInvestigationRoutes(app, db, { demoPacingMs: opts.demoPacingMs });
  registerAIRoutes(app, db);
  registerJobRoutes(app, queue);
  registerMetrics(app, queue);
  if (env.inlineWorker && env.bisectJobsEnabled && !env.publicDemo) {
    const stop = new AbortController();
    void workLoop(queue, { sandbox: "docker", runtime: process.env.SANDBOX_RUNTIME }, stop.signal, { log: (msg, extra) => app.log.info(extra ?? {}, msg) });
    app.addHook("onClose", async () => stop.abort());
  }
  if (env.webDistPath) await app.register(fastifyStatic, { root: env.webDistPath, wildcard: false });
  app.addHook("onClose", async () => {
    db.close();
    await queue.close();
  });
  return { app, db };
}
