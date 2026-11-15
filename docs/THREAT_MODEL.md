# Threat model: running someone else's test suite

A bisect job runs a repository's own test command at many commits. That code is untrusted: a malicious or compromised commit can do anything its process is allowed to do. This document lists what the sandbox defends against, how, and what it does not cover.

## Assets

| Asset | Where it lives |
|---|---|
| Host or node (kernel, other workloads) | The machine running the sandbox |
| Secrets (`GEMINI_API_KEY`, `GITHUB_TOKEN`, `JOBS_TOKEN`, cloud credentials) | API and worker environment, cloud metadata service |
| Other jobs' code and results | Clone cache, Redis |
| The service's availability | CPU, memory, disk, the job queue |

## Threats and controls

| Threat | Control (Docker sandbox) | Control (Kubernetes sandbox) |
|---|---|---|
| Container escape via a kernel bug | Optional gVisor (`--runtime=runsc`): syscalls hit a user-space kernel, not the host's | Test pods use RuntimeClass `gvisor`; on GKE they schedule only onto the dedicated GKE Sandbox node pool |
| Privilege escalation inside the container | `--cap-drop=ALL`, `--security-opt=no-new-privileges`, non-root `--user=1000:1000` | `runAsNonRoot`, `allowPrivilegeEscalation: false`, drop all capabilities, seccomp `RuntimeDefault` |
| Tampering with the checkout or installed dependencies to influence later runs | Source and `node_modules` mounted read-only; `--read-only` root; writable `/tmp` only (tmpfs, size-capped) | `readOnlyRootFilesystem`; per-run `emptyDir`; nothing shared between runs |
| Exfiltrating secrets | No secrets are passed into sandboxes; `--network=none` for the test step | No service-account token (`automountServiceAccountToken: false`); egress limited to DNS and port 443 outside private ranges and `169.254.0.0/16` (blocks cloud metadata) |
| Reaching internal services (Redis, the API, the cluster) | No network | NetworkPolicy: no ingress to sandbox pods; private ranges excluded from egress; Redis accepts only API and worker pods |
| Resource exhaustion (fork bombs, memory, disk, infinite loops) | `--pids-limit`, `--memory` with no swap, `--cpus`, tmpfs size, wall-clock timeout then `docker kill` | Resource limits, `ephemeral-storage` limit, `activeDeadlineSeconds`, `backoffLimit: 0` |
| Malicious install scripts | `npm ci --ignore-scripts` by default; install is the only step with network; its result is cached by a content hash of `package.json` and the lockfile | Same install command, in an init container with the same restrictions |
| Argument or command injection through refs and URLs | Refs validated against `^[\w./~^-]+$` and rejected if they start with `-`; every git and docker call uses an argument vector, never a shell; job URLs must be `https://` | Same validation at the API (zod) and in the worker |
| Unauthorized job creation | Jobs off unless `BISECT_JOBS_ENABLED=true`; always off with `PUBLIC_DEMO=true`; optional bearer token compared in constant time | Same, with the token in a Kubernetes Secret |
| A worker dying mid-job | Reliable queue: `BLMOVE pending → processing`; stale jobs are requeued, then failed after 3 attempts | Same; SIGTERM drains the current job (grace period = run timeout + 2 min) |

## Known gaps

- **Plain NetworkPolicy cannot match domain names.** Sandbox egress is "any public IP on 443", not "github.com and registry.npmjs.org only". On Cilium (GKE Dataplane V2), replace the 443 rule with a `toFQDNs` allowlist.
- **The Docker sandbox in docker-compose mounts the Docker socket into the worker.** That container can control the host's Docker. It is acceptable on a developer machine and is why production uses Kubernetes Jobs, where the worker has RBAC for Jobs in one namespace and nothing else.
- **Without gVisor, isolation is namespaces plus seccomp.** That is standard for containers but shares the host kernel. Enable `runsc` wherever untrusted repositories are accepted.
- **The install step has network access.** A malicious dependency with `--ignore-scripts` disabled can run code during install. Keep `--ignore-scripts` unless a project needs lifecycle scripts, and then only for trusted repositories.
- **`LocalRunner` has no isolation.** It refuses to start without an explicit opt-in and is meant only for already-disposable CI runners, such as the GitHub Action, where the runner VM is the sandbox.
