// Executes a repository's own test command at one commit, isolated from the host.
// See docs/THREAT_MODEL.md for what each control defends against.
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { run, runOk, tail } from "./exec";
import { assertRef, checkoutWorktree } from "./git";

export interface RunResult {
  sha: string;
  verdict: "pass" | "fail";
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  logTail: string;
  cacheHit?: boolean;
}

export interface RunOptions {
  /** Unified diff applied to the checkout before the test command runs (to verify a proposed fix). */
  patch?: string;
}

export interface TestRunner {
  readonly kind: string;
  run(sha: string, opts?: RunOptions): Promise<RunResult>;
}

export interface SandboxLimits {
  /** Wall-clock limit per test run. */
  timeoutMs: number;
  cpus: number;
  memoryMb: number;
  pids: number;
  tmpMb: number;
  /** Size of the writable scratch copy of the source used by each test run. */
  workMb: number;
}

export const DEFAULT_LIMITS: SandboxLimits = { timeoutMs: 10 * 60_000, cpus: 2, memoryMb: 2048, pids: 512, tmpMb: 512, workMb: 2048 };

export interface DockerSandboxOptions {
  repo: string;
  testCommand: string;
  /** Install step run once per distinct set of manifests and lockfiles; the only step with network access. Defaults by lockfile. */
  installCommand?: string;
  image?: string;
  /** e.g. "runsc" for gVisor. Unset uses the daemon's default runtime. */
  runtime?: string;
  limits?: Partial<SandboxLimits>;
  docker?: string;
}

const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"];
/** Written by the install step: one `node_modules` directory per line, relative to the repository root. */
export const NODE_MODULES_MANIFEST = ".causalci-node-modules";

/** Install command matching the repository's package manager (lifecycle scripts off by default). */
export async function defaultInstallCommand(worktree: string): Promise<string> {
  const has = (f: string) => readFile(join(worktree, f)).then(() => true, () => false);
  if (await has("pnpm-lock.yaml")) return "corepack enable --install-directory /tmp/bin && /tmp/bin/pnpm install --frozen-lockfile --ignore-scripts";
  if (await has("yarn.lock")) return "corepack yarn install --frozen-lockfile --ignore-scripts || corepack yarn install --immutable --mode=skip-build";
  if ((await has("package-lock.json")) || (await has("npm-shrinkwrap.json"))) return "npm ci --ignore-scripts --no-audit --no-fund";
  if (await has("package.json")) return "npm install --ignore-scripts --no-audit --no-fund";
  return "true";
}

/**
 * Content hash of every dependency input in the repository (root and workspace package.json files
 * plus lockfiles): equal hashes reuse the same installed dependencies.
 */
export async function dependencyKey(worktree: string, installCommand: string, image: string): Promise<string> {
  const h = createHash("sha256").update(image).update("\0").update(installCommand);
  const listed = await run("git", ["-C", worktree, "ls-files", "--", "package.json", "**/package.json", ...LOCKFILES, ...LOCKFILES.map((l) => `**/${l}`)], { timeoutMs: 30_000 }).catch(() => null);
  const files = listed?.code === 0 ? listed.stdout.split("\n").filter((f) => f && !f.includes("node_modules/")).sort() : ["package.json", ...LOCKFILES];
  for (const f of files) {
    const content = await readFile(join(worktree, f)).catch(() => null);
    h.update("\0").update(f).update("\0");
    if (content) h.update(content);
  }
  return h.digest("hex").slice(0, 16);
}

/** Hardening flags shared by every container the sandbox starts. Exported for tests and docs. */
export function hardeningArgs(limits: SandboxLimits, runtime?: string): string[] {
  return [
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--pids-limit=${limits.pids}`,
    `--memory=${limits.memoryMb}m`,
    `--memory-swap=${limits.memoryMb}m`,
    `--cpus=${limits.cpus}`,
    `--tmpfs=/tmp:rw,nosuid,nodev,size=${limits.tmpMb}m`,
    ...(runtime ? [`--runtime=${runtime}`] : []),
  ];
}

/**
 * The test step: the read-only checkout is copied into a size-capped scratch area, every cached
 * `node_modules` directory (root and workspaces) is linked in from the read-only dependency volume,
 * and the test command runs there with no network.
 */
export const TEST_SCRIPT = `set -e
cp -a /src/. /work/
if [ -f /deps/${NODE_MODULES_MANIFEST} ]; then
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    mkdir -p "/work/$(dirname "$p")"
    rm -rf "/work/$p"
    ln -s "/deps/$p" "/work/$p"
  done < /deps/${NODE_MODULES_MANIFEST}
fi
cd /work
exec sh -c "$CAUSALCI_TEST"`;

/** The install step: copy the checkout into the dependency volume, install there, record every node_modules it produced. */
export const INSTALL_SCRIPT = `set -e
cp -a /src/. /deps/
cd /deps
sh -c "$CAUSALCI_INSTALL"
find . -name node_modules -type d -prune | sed 's|^[.]/||' > /deps/${NODE_MODULES_MANIFEST}`;

/** Arguments for the offline test container. Exported so the isolation contract is unit-tested. */
export function testContainerArgs(o: { name: string; worktree: string; depsVolume: string; image: string; testCommand: string; limits: SandboxLimits; runtime?: string }): string[] {
  return [
    "run",
    "--rm",
    `--name=${o.name}`,
    "--network=none",
    "--user=1000:1000",
    ...hardeningArgs(o.limits, o.runtime),
    `--tmpfs=/work:rw,exec,nosuid,nodev,uid=1000,gid=1000,size=${o.limits.workMb}m`,
    "--env=CI=1",
    "--env=HOME=/tmp",
    "--env=npm_config_cache=/tmp/.npm",
    `--env=CAUSALCI_TEST=${o.testCommand}`,
    `--volume=${o.worktree}:/src:ro`,
    `--volume=${o.depsVolume}:/deps:ro`,
    "--workdir=/work",
    o.image,
    "sh",
    "-c",
    TEST_SCRIPT,
  ];
}

export function installContainerArgs(o: { name: string; worktree: string; depsVolume: string; image: string; installCommand: string; limits: SandboxLimits; runtime?: string }): string[] {
  return [
    "run",
    "--rm",
    `--name=${o.name}`,
    ...hardeningArgs(o.limits, o.runtime),
    "--env=CI=1",
    "--env=HOME=/tmp",
    "--env=npm_config_cache=/tmp/.npm",
    "--env=COREPACK_HOME=/tmp/corepack",
    `--env=CAUSALCI_INSTALL=${o.installCommand}`,
    `--volume=${o.worktree}:/src:ro`,
    `--volume=${o.depsVolume}:/deps`,
    "--workdir=/deps",
    o.image,
    "sh",
    "-c",
    INSTALL_SCRIPT,
  ];
}

/** Applies a proposed patch to a checkout; a patch that does not apply is a failed verification, not an error. */
async function applyPatch(dir: string, patch: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const r = await run("git", ["-C", dir, "apply", "--whitespace=nowarn", "-"], { input: patch.endsWith("\n") ? patch : `${patch}\n`, timeoutMs: 60_000 });
  return r.code === 0 ? { ok: true } : { ok: false, message: `The patch does not apply to this commit: ${r.stderr.trim().slice(0, 500)}` };
}

/**
 * Docker (optionally gVisor) sandbox. Each run gets a fresh worktree mounted read-only, a cached
 * dependency volume mounted read-only, no network, no capabilities, and hard resource limits.
 */
export class DockerSandbox implements TestRunner {
  readonly kind = "docker";
  private readonly limits: SandboxLimits;
  private readonly image: string;
  private readonly docker: string;

  constructor(private readonly o: DockerSandboxOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
    this.image = o.image ?? "node:22-bookworm-slim";
    this.docker = o.docker ?? "docker";
  }

  static async available(docker = "docker"): Promise<boolean> {
    const r = await run(docker, ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 10_000 }).catch(() => null);
    return !!r && r.code === 0;
  }

  async run(sha: string, opts: RunOptions = {}): Promise<RunResult> {
    assertRef(sha, "sha");
    const wt = await checkoutWorktree(this.o.repo, sha);
    try {
      if (opts.patch) {
        const applied = await applyPatch(wt.dir, opts.patch);
        if (!applied.ok) return { sha, verdict: "fail", exitCode: null, timedOut: false, durationMs: 0, logTail: applied.message };
      }
      const installCommand = this.o.installCommand ?? (await defaultInstallCommand(wt.dir));
      const key = await dependencyKey(wt.dir, installCommand, this.image);
      const volume = `causalci-deps-${key}`;
      const exists = (await run(this.docker, ["volume", "inspect", volume], { timeoutMs: 20_000 })).code === 0;
      if (!exists) {
        await runOk(this.docker, ["volume", "create", "--label", "causalci=deps", volume], { timeoutMs: 20_000 });
        const install = await run(this.docker, installContainerArgs({ name: `causalci-install-${randomBytes(4).toString("hex")}`, worktree: wt.dir, depsVolume: volume, image: this.image, installCommand, limits: this.limits, runtime: this.o.runtime }), { timeoutMs: this.limits.timeoutMs });
        if (install.code !== 0) {
          await run(this.docker, ["volume", "rm", "-f", volume]).catch(() => undefined);
          // An install failure is a property of the commit (broken lockfile), not of the sandbox.
          return { sha, verdict: "fail", exitCode: install.code, timedOut: install.timedOut, durationMs: install.durationMs, logTail: tail(`[install] ${install.stdout}\n${install.stderr}`), cacheHit: false };
        }
      }
      const name = `causalci-test-${randomBytes(4).toString("hex")}`;
      const r = await run(this.docker, testContainerArgs({ name, worktree: wt.dir, depsVolume: volume, image: this.image, testCommand: this.o.testCommand, limits: this.limits, runtime: this.o.runtime }), { timeoutMs: this.limits.timeoutMs });
      if (r.timedOut) await run(this.docker, ["kill", name], { timeoutMs: 20_000 }).catch(() => undefined);
      return { sha, verdict: r.code === 0 && !r.timedOut ? "pass" : "fail", exitCode: r.code, timedOut: r.timedOut, durationMs: r.durationMs, logTail: tail(`${r.stdout}\n${r.stderr}`), cacheHit: exists };
    } finally {
      await wt.cleanup();
    }
  }
}

/**
 * Runs the test command directly on this machine. Only for environments that are already
 * disposable sandboxes (an ephemeral CI runner); refuses to start without an explicit opt-in.
 */
export class LocalRunner implements TestRunner {
  readonly kind = "local";
  constructor(private readonly o: { repo: string; testCommand: string; installCommand?: string; timeoutMs?: number; iUnderstandThisRunsUntrustedCode: boolean }) {
    if (!o.iUnderstandThisRunsUntrustedCode) throw new Error("LocalRunner executes repository code on this machine; pass iUnderstandThisRunsUntrustedCode to opt in.");
  }
  async run(sha: string, opts: RunOptions = {}): Promise<RunResult> {
    const wt = await checkoutWorktree(this.o.repo, assertRef(sha, "sha"));
    try {
      if (opts.patch) {
        const applied = await applyPatch(wt.dir, opts.patch);
        if (!applied.ok) return { sha, verdict: "fail", exitCode: null, timedOut: false, durationMs: 0, logTail: applied.message };
      }
      const timeoutMs = this.o.timeoutMs ?? DEFAULT_LIMITS.timeoutMs;
      if (this.o.installCommand) {
        const i = await run("sh", ["-c", this.o.installCommand], { cwd: wt.dir, timeoutMs });
        if (i.code !== 0) return { sha, verdict: "fail", exitCode: i.code, timedOut: i.timedOut, durationMs: i.durationMs, logTail: tail(`[install] ${i.stdout}\n${i.stderr}`) };
      }
      const r = await run("sh", ["-c", this.o.testCommand], { cwd: wt.dir, timeoutMs, env: { ...process.env, CI: "1" } });
      return { sha, verdict: r.code === 0 && !r.timedOut ? "pass" : "fail", exitCode: r.code, timedOut: r.timedOut, durationMs: r.durationMs, logTail: tail(`${r.stdout}\n${r.stderr}`) };
    } finally {
      await wt.cleanup();
    }
  }
}

export interface KubernetesSandboxOptions {
  /** Clone URL reachable from the cluster. */
  repoUrl: string;
  testCommand: string;
  installCommand?: string;
  namespace?: string;
  image?: string;
  gitImage?: string;
  /** RuntimeClass name, e.g. "gvisor". */
  runtimeClassName?: string;
  limits?: Partial<SandboxLimits>;
  kubectl?: string;
}

/**
 * Pod spec for one test run as a Kubernetes Job. Exported so the hardening is unit-tested.
 * Network: Kubernetes cannot drop the network per container, so egress for pods labelled
 * `app.kubernetes.io/component=sandbox` is restricted by the chart's NetworkPolicy instead
 * (git host and package registry only). The test container itself runs as non-root with a
 * read-only root filesystem, no capabilities and the RuntimeDefault seccomp profile.
 */
export function sandboxJobManifest(o: KubernetesSandboxOptions & { name: string; sha: string; patch?: string }) {
  const limits = { ...DEFAULT_LIMITS, ...o.limits };
  const image = o.image ?? "node:22-bookworm-slim";
  const restricted = {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
    seccompProfile: { type: "RuntimeDefault" },
  };
  const resources = {
    limits: { cpu: String(limits.cpus), memory: `${limits.memoryMb}Mi`, "ephemeral-storage": "4Gi" },
    requests: { cpu: String(Math.min(1, limits.cpus)), memory: `${Math.min(1024, limits.memoryMb)}Mi` },
  };
  const env = [
    { name: "CI", value: "1" },
    { name: "HOME", value: "/tmp" },
    { name: "npm_config_cache", value: "/tmp/.npm" },
  ];
  const mounts = [
    { name: "src", mountPath: "/src" },
    { name: "tmp", mountPath: "/tmp" },
  ];
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: o.name, namespace: o.namespace ?? "causalci", labels: { "app.kubernetes.io/name": "causalci", "app.kubernetes.io/component": "sandbox" } },
    spec: {
      backoffLimit: 0,
      activeDeadlineSeconds: Math.ceil(limits.timeoutMs / 1000),
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels: { "app.kubernetes.io/name": "causalci", "app.kubernetes.io/component": "sandbox" } },
        spec: {
          restartPolicy: "Never",
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          ...(o.runtimeClassName ? { runtimeClassName: o.runtimeClassName } : {}),
          securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
          volumes: [
            { name: "src", emptyDir: { sizeLimit: "4Gi" } },
            { name: "tmp", emptyDir: { sizeLimit: `${limits.tmpMb}Mi` } },
          ],
          initContainers: [
            {
              name: "checkout",
              image: o.gitImage ?? "alpine/git:2.47.2",
              args: ["sh", "-c", 'git clone --quiet --no-tags "$REPO_URL" /src && git -C /src checkout --quiet --detach "$SHA" && if [ -n "$PATCH_B64" ]; then echo "$PATCH_B64" | base64 -d | git -C /src apply --whitespace=nowarn -; fi'],
              env: [...env, { name: "REPO_URL", value: o.repoUrl }, { name: "SHA", value: o.sha }, { name: "PATCH_B64", value: o.patch ? Buffer.from(o.patch).toString("base64") : "" }],
              securityContext: restricted,
              resources,
              volumeMounts: mounts,
            },
            {
              name: "install",
              image,
              args: ["sh", "-c", o.installCommand ?? "npm ci --ignore-scripts --no-audit --no-fund"],
              workingDir: "/src",
              env,
              securityContext: restricted,
              resources,
              volumeMounts: mounts,
            },
          ],
          containers: [{ name: "test", image, args: ["sh", "-c", o.testCommand], workingDir: "/src", env, securityContext: restricted, resources, volumeMounts: mounts }],
        },
      },
    },
  };
}

export class KubernetesSandbox implements TestRunner {
  readonly kind = "kubernetes";
  private readonly kubectl: string;
  private readonly ns: string;
  constructor(private readonly o: KubernetesSandboxOptions) {
    this.kubectl = o.kubectl ?? "kubectl";
    this.ns = o.namespace ?? "causalci";
  }

  async run(sha: string, opts: RunOptions = {}): Promise<RunResult> {
    assertRef(sha, "sha");
    const name = `causalci-run-${sha.slice(0, 8)}-${randomBytes(3).toString("hex")}`;
    const manifest = sandboxJobManifest({ ...this.o, name, sha, patch: opts.patch });
    const started = Date.now();
    const timeoutMs = { ...DEFAULT_LIMITS, ...this.o.limits }.timeoutMs + 5 * 60_000;
    await runOk(this.kubectl, ["apply", "-n", this.ns, "-f", "-"], { input: JSON.stringify(manifest), timeoutMs: 60_000 });
    try {
      for (;;) {
        const raw = await runOk(this.kubectl, ["get", "job", name, "-n", this.ns, "-o", "json"], { timeoutMs: 30_000 });
        const status = (JSON.parse(raw) as { status?: { succeeded?: number; failed?: number } }).status ?? {};
        const done = (status.succeeded ?? 0) > 0 || (status.failed ?? 0) > 0;
        const timedOut = Date.now() - started > timeoutMs;
        if (done || timedOut) {
          const logs = await run(this.kubectl, ["logs", `job/${name}`, "-n", this.ns, "-c", "test", "--tail=200"], { timeoutMs: 30_000 });
          return { sha, verdict: (status.succeeded ?? 0) > 0 ? "pass" : "fail", exitCode: (status.succeeded ?? 0) > 0 ? 0 : null, timedOut: !done, durationMs: Date.now() - started, logTail: tail(logs.stdout) };
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    } finally {
      await run(this.kubectl, ["delete", "job", name, "-n", this.ns, "--ignore-not-found", "--wait=false"], { timeoutMs: 30_000 }).catch(() => undefined);
    }
  }
}
