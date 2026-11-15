import { spawn } from "node:child_process";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  input?: string;
  env?: NodeJS.ProcessEnv;
  /** Keep only the last N bytes of each stream (logs of a test suite can be huge). */
  maxBytes?: number;
}

/** Runs a program with an argument vector (never through a shell), capturing bounded output. */
export function run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const max = opts.maxBytes ?? 4 * 1024 * 1024;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const keep = (buf: string, chunk: Buffer) => {
      const next = buf + chunk.toString("utf8");
      return next.length > max ? next.slice(next.length - max) : next;
    };
    child.stdout.on("data", (c: Buffer) => (stdout = keep(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = keep(stderr, c)));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Like `run`, but throws with stderr when the exit code is not 0. */
export async function runOk(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed (exit ${r.code}${r.timedOut ? ", timed out" : ""}): ${r.stderr.trim().slice(-800)}`);
  return r.stdout;
}

export function tail(s: string, chars = 4000): string {
  return s.length > chars ? `…${s.slice(s.length - chars)}` : s;
}
