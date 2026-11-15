// Bisect jobs flow API → queue → worker. Redis in production (lets workers scale horizontally and
// gives KEDA a queue length to scale on); an in-memory queue for single-process development.
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { Strategy } from "./hunt";

export interface BisectJobInput {
  /** "bisect" finds the first failing commit in (good, bad]; "verify" runs the tests at `bad` with `patch` applied. */
  kind?: "bisect" | "verify";
  repoUrl: string;
  good: string;
  bad: string;
  testCommand: string;
  installCommand?: string;
  strategy?: Strategy;
  parallel?: number;
  patch?: string;
  /** Links the job back to an investigation (and a proposed fix) so results update them. */
  investigationId?: string;
  patchId?: string;
}

export interface VerifyResult {
  kind: "verify";
  sha: string;
  verdict: "pass" | "fail";
  timedOut: boolean;
  durationMs: number;
  logTail: string;
}

export type JobState = "queued" | "running" | "succeeded" | "failed";

export interface BisectJob {
  id: string;
  input: BisectJobInput;
  state: JobState;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  attempts: number;
  result: unknown;
  error: string | null;
}

export interface JobQueue {
  enqueue(input: BisectJobInput): Promise<BisectJob>;
  /** Blocks up to `timeoutSec` for the next job and marks it running. */
  claim(timeoutSec: number): Promise<BisectJob | null>;
  complete(id: string, result: unknown): Promise<void>;
  fail(id: string, error: string): Promise<void>;
  get(id: string): Promise<BisectJob | null>;
  depth(): Promise<number>;
  close(): Promise<void>;
}

const newJob = (input: BisectJobInput): BisectJob => ({ id: randomUUID(), input, state: "queued", createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, attempts: 0, result: null, error: null });

export class MemoryQueue implements JobQueue {
  private jobs = new Map<string, BisectJob>();
  private pending: string[] = [];
  private waiters: ((id: string | null) => void)[] = [];

  async enqueue(input: BisectJobInput) {
    const job = newJob(input);
    this.jobs.set(job.id, job);
    const w = this.waiters.shift();
    if (w) w(job.id);
    else this.pending.push(job.id);
    return job;
  }
  async claim(timeoutSec: number) {
    const id =
      this.pending.shift() ??
      (await new Promise<string | null>((resolve) => {
        const t = setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== done);
          resolve(null);
        }, timeoutSec * 1000);
        const done = (v: string | null) => {
          clearTimeout(t);
          resolve(v);
        };
        this.waiters.push(done);
      }));
    if (!id) return null;
    const job = this.jobs.get(id)!;
    Object.assign(job, { state: "running", startedAt: new Date().toISOString(), attempts: job.attempts + 1 });
    return job;
  }
  async complete(id: string, result: unknown) {
    const j = this.jobs.get(id);
    if (j) Object.assign(j, { state: "succeeded", result, finishedAt: new Date().toISOString() });
  }
  async fail(id: string, error: string) {
    const j = this.jobs.get(id);
    if (j) Object.assign(j, { state: "failed", error, finishedAt: new Date().toISOString() });
  }
  async get(id: string) {
    return this.jobs.get(id) ?? null;
  }
  async depth() {
    return this.pending.length;
  }
  async close() {
    for (const w of this.waiters) w(null);
    this.waiters = [];
  }
}

/**
 * Reliable-queue pattern: BLMOVE pending → processing, so a job claimed by a worker that dies is
 * still in `processing` and can be requeued by `recoverStale`, instead of being lost.
 */
export class RedisQueue implements JobQueue {
  private readonly pendingKey: string;
  private readonly processingKey: string;
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "causalci",
  ) {
    this.pendingKey = `${prefix}:jobs:pending`;
    this.processingKey = `${prefix}:jobs:processing`;
  }
  private key(id: string) {
    return `${this.prefix}:job:${id}`;
  }
  private async save(job: BisectJob) {
    await this.redis.set(this.key(job.id), JSON.stringify(job), "EX", 7 * 24 * 3600);
  }
  async enqueue(input: BisectJobInput) {
    const job = newJob(input);
    await this.save(job);
    await this.redis.lpush(this.pendingKey, job.id);
    return job;
  }
  async claim(timeoutSec: number) {
    const id = await this.redis.blmove(this.pendingKey, this.processingKey, "RIGHT", "LEFT", timeoutSec);
    if (!id) return null;
    const job = await this.get(id);
    if (!job) return null;
    Object.assign(job, { state: "running", startedAt: new Date().toISOString(), attempts: job.attempts + 1 });
    await this.save(job);
    return job;
  }
  private async finish(id: string, patch: Partial<BisectJob>) {
    const job = await this.get(id);
    if (job) await this.save({ ...job, ...patch, finishedAt: new Date().toISOString() });
    await this.redis.lrem(this.processingKey, 1, id);
  }
  complete(id: string, result: unknown) {
    return this.finish(id, { state: "succeeded", result });
  }
  fail(id: string, error: string) {
    return this.finish(id, { state: "failed", error });
  }
  async get(id: string) {
    const raw = await this.redis.get(this.key(id));
    return raw ? (JSON.parse(raw) as BisectJob) : null;
  }
  depth() {
    return this.redis.llen(this.pendingKey);
  }
  /** Moves jobs that have been running longer than `maxAgeMs` back to pending (worker crashed). */
  async recoverStale(maxAgeMs: number, maxAttempts = 3): Promise<number> {
    let moved = 0;
    for (const id of await this.redis.lrange(this.processingKey, 0, -1)) {
      const job = await this.get(id);
      if (!job?.startedAt || Date.now() - Date.parse(job.startedAt) < maxAgeMs) continue;
      await this.redis.lrem(this.processingKey, 1, id);
      if (job.attempts >= maxAttempts) await this.save({ ...job, state: "failed", error: `Abandoned after ${job.attempts} attempts`, finishedAt: new Date().toISOString() });
      else {
        await this.save({ ...job, state: "queued" });
        await this.redis.lpush(this.pendingKey, id);
      }
      moved++;
    }
    return moved;
  }
  async close() {
    await this.redis.quit();
  }
}

export async function queueFromEnv(env = process.env): Promise<JobQueue> {
  if (!env.REDIS_URL) return new MemoryQueue();
  const { Redis } = await import("ioredis");
  return new RedisQueue(new Redis(env.REDIS_URL, { maxRetriesPerRequest: null }), env.QUEUE_PREFIX ?? "causalci");
}
